/**
 * 도박장 (Google Apps Script 웹 앱 버전)
 * - 이 스크립트가 붙어있는 구글 시트에 모든 데이터(유저·도박·채팅·상점)를 저장합니다.
 * - 서버/호스팅 없이 웹 앱 링크 하나로 동작. 사이트 전용 포인트(실제 돈과 무관).
 * - 처음 한 번 showAdminLink()를 실행하면 시트의 '관리자' 탭에 관리자 링크가 생깁니다.
 */
var RPS = { HANDS: ['rock', 'paper', 'scissors'], BEATS: { rock: 'scissors', scissors: 'paper', paper: 'rock' }, EXPIRE_MS: 12 * 3600e3, MAX_OPEN: 3 };
var CFG = { SHOP_OPEN: false, /* 상점 열기/닫기: true 로 바꾸고 새 버전으로 배포하면 열려요 */ START_POINTS: 1000, MIN_BET: 10, DAILY_AID: 100, UNDERDOG_SHARE: 0.30, UNDERDOG_BONUS: 0.20, LUCKY_CHANCE: 0.07, LUCKY_BONUS: 0.5 };

var SHEETS = {
  users: ['id', 'name', 'salt', 'hash', 'points', 'last_aid', 'created_at', 'eq_title', 'eq_color', 'eq_fx', 'eq_badge', 'grp'],
  sessions: ['token', 'user_id', 'created_at'],
  bets: ['id', 'title', 'creator_id', 'status', 'winner', 'closes_at', 'created_at'],
  options: ['id', 'bet_id', 'label'],
  wagers: ['id', 'bet_id', 'option_id', 'user_id', 'amount', 'payout', 'lucky', 'created_at'],
  messages: ['id', 'user_id', 'text', 'created_at', 'bet_id'],
  items: ['user_id', 'item_id'],
  rps: ['id', 'host_id', 'stake', 'host_hand', 'guest_id', 'guest_hand', 'status', 'result', 'created_at', 'played_at'],
  lun: ['id', 'host_id', 'stake', 'cap', 'status', 'winner_id', 'created_at', 'played_at'],
  lunp: ['id', 'room_id', 'user_id', 'num', 'joined_at'],
  lad: ['id', 'host_id', 'stake', 'slots', 'status', 'win_end', 'rungs', 'winner_id', 'created_at', 'played_at'],
  ladp: ['id', 'room_id', 'user_id', 'slot', 'joined_at'],
  bj: ['id', 'user_id', 'bet', 'state', 'status', 'outcome', 'payout', 'created_at', 'finished_at'],
  slots: ['id', 'user_id', 'bet', 'reels', 'payout', 'created_at']
};

/* ================= 웹 앱 진입점 ================= */
function doGet(e) {
  var adminParam = e && e.parameter && e.parameter.admin;
  var t = HtmlService.createTemplateFromFile(adminParam !== undefined ? 'admin' : 'index');
  t.adminKey = JSON.stringify(String(adminParam || '')).replace(/</g, '\\u003c');
  return t.evaluate().setTitle(adminParam !== undefined ? '관리자' : '도박장')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 브라우저(google.script.run)가 부르는 단 하나의 함수. 결과는 JSON 문자열. */
var HOLDING = false; // 이 실행이 이미 스크립트 락을 잡고 있는지 (락은 재진입이 안 돼서 구분 필요)
function handle(token, adminKey, method, url, body) {
  var write = method === 'POST', lock = null;
  try {
    var parts = String(url).split('?'), path = parts[0], qs = {};
    (parts[1] || '').split('&').forEach(function (kv) { if (kv) { var p = kv.split('='); qs[p[0]] = decodeURIComponent(p[1] || ''); } });
    var fn = ROUTES[method + ' ' + path];
    if (!fn) fail(404, '없는 주소예요.');
    if (write) { lock = LockService.getScriptLock(); lock.waitLock(25000); HOLDING = true; }
    var ctx = { token: String(token || ''), adminKey: String(adminKey || ''), qs: qs };
    ctx.user = authUser(ctx.token);
    if (ctx.token && !ctx.user) fail(401, '다시 로그인해주세요.');
    return JSON.stringify({ data: fn(body || {}, ctx.user, ctx) });
  } catch (e) {
    if (e && e.http) return JSON.stringify({ error: e.message, code: e.http });
    console.error(e && e.stack || e);
    return JSON.stringify({ error: '서버 오류: ' + (e && e.message), code: 500 });
  } finally { if (lock) lock.releaseLock(); }
}

/* ================= 시트 = 테이블 ================= */
var TBL = {};
function tbl(name) { return TBL[name] || (TBL[name] = new Table(name)); }
function toCell(v) { return v === null || v === undefined ? '' : (typeof v === 'string' && v !== '' ? '\u200B' + v : v); } // 글자 앞 보이지 않는 표시 → 시트가 숫자/날짜/수식으로 오해하지 않게
function fromCell(v) { return typeof v === 'string' ? v.replace(/^\u200B/, '') : v; }

function Table(name) {
  this.name = name; this.cols = SHEETS[name]; this.rows = null;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  this.sheet = ss.getSheetByName(name);
  if (!this.sheet) {
    this.sheet = ss.insertSheet(name);
    this.sheet.getRange(1, 1, 1, this.cols.length).setValues([this.cols]).setFontWeight('bold');
    this.sheet.setFrozenRows(1);
  } else if (this.sheet.getLastColumn() < this.cols.length) {   // 버전업으로 열이 늘어난 경우 머리글만 보강
    this.sheet.getRange(1, 1, 1, this.cols.length).setValues([this.cols]).setFontWeight('bold');
  }
}
Table.prototype.all = function () {
  if (!this.rows) {
    var n = this.sheet.getLastRow() - 1, cols = this.cols;
    var vals = n > 0 ? this.sheet.getRange(2, 1, n, cols.length).getValues() : [];
    this.rows = vals.map(function (v, i) { var o = { _row: i + 2 }; cols.forEach(function (c, j) { o[c] = fromCell(v[j]); }); return o; });
  }
  return this.rows;
};
Table.prototype.find = function (fn) { return this.all().filter(fn)[0] || null; };
Table.prototype.where = function (fn) { return this.all().filter(fn); };
Table.prototype.insert = function (o) {
  if (this.cols[0] === 'id') o.id = this.all().reduce(function (m, r) { return Math.max(m, r.id); }, 0) + 1;
  this.sheet.appendRow(this.cols.map(function (c) { return toCell(o[c]); }));
  o._row = this.sheet.getLastRow(); this.all().push(o); return o;
};
Table.prototype.save = function (o) { this.sheet.getRange(o._row, 1, 1, this.cols.length).setValues([this.cols.map(function (c) { return toCell(o[c]); })]); };
Table.prototype.remove = function (o) {
  this.sheet.deleteRow(o._row);
  var rows = this.all(); rows.splice(rows.indexOf(o), 1);
  rows.forEach(function (r) { if (r._row > o._row) r._row--; });
};
Table.prototype.removeWhere = function (fn) { var self = this; this.where(fn).sort(function (a, b) { return b._row - a._row; }).forEach(function (o) { self.remove(o); }); };

/* ================= 공통 도구 ================= */
function fail(code, msg) { var e = new Error(msg); e.http = code; throw e; }
function now() { return Date.now(); }
function props() { return PropertiesService.getScriptProperties(); }
function secret(key) {
  var p = props(), v = p.getProperty(key);
  if (!v) { v = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''); p.setProperty(key, v); }
  return v;
}
function hashPin(pin, salt) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, secret('PEPPER') + salt + pin);
  return Utilities.base64Encode(d);
}
/** PIN이 같은 사람끼리만 같은 '방'. 방 번호(grp)는 PIN에서 만든 값이고, 도박·가위바위보·채팅·랭킹은 같은 방끼리만 보여요. */
function groupKey(pin) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, secret('PEPPER') + 'grp:' + pin)).slice(0, 16);
}
function grpOf(u) { return u && u.grp ? String(u.grp) : ''; }
function sameRoom(userId, me) { var o = userById(userId); return !!o && grpOf(o) === grpOf(me); }
function throttle(key, limit) {
  var c = CacheService.getScriptCache(), n = Number(c.get(key) || 0);
  if (n >= limit) fail(429, '시도가 너무 많아요. 5분 뒤 다시 해주세요.');
  c.put(key, String(n + 1), 300);
}
var NAME_RE = /^[\p{L}\p{N}_ ]{1,12}$/u;
function checkName(raw) {
  var name = String(raw || '').trim();
  if (!NAME_RE.test(name)) fail(400, '닉네임은 12자 이내 글자/숫자만 가능해요.');
  return name;
}
function userById(id) { return tbl('users').find(function (u) { return u.id === id; }); }
function addPoints(userId, delta) { var u = userById(userId); if (u) { u.points += delta; tbl('users').save(u); } }

/* ================= 인증 ================= */
function newSession(userId) {
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  tbl('sessions').insert({ token: token, user_id: userId, created_at: now() });
  CacheService.getScriptCache().put('s_' + token, String(userId), 21600);
  return token;
}
function authUser(token) {
  if (!token) return null;
  var cache = CacheService.getScriptCache(), id = cache.get('s_' + token);
  if (!id) {
    var s = tbl('sessions').find(function (r) { return r.token === token; });
    if (!s) return null;
    id = String(s.user_id); cache.put('s_' + token, id, 21600);
  }
  return userById(Number(id));
}
function adminOnly(ctx) {
  throttle('admin|x', 20);
  if (!ctx.adminKey || ctx.adminKey !== secret('ADMIN_KEY')) fail(403, '관리자 키가 틀렸어요.');
  CacheService.getScriptCache().remove('admin|x');
}

/* ================= 상점 ================= */
var SHOP = [];
[['t_gambler', '도박꾼', 300], ['t_dog', '역배 장인', 500], ['t_lucky', '행운아', 800], ['t_whale', '큰손', 1500], ['t_oracle', '예언가', 2500], ['t_legend', '전설', 5000]]
  .forEach(function (a) { SHOP.push({ id: a[0], slot: 'title', name: a[1], price: a[2], value: a[1] }); });
[['c_pink', '네온 핑크', 200, '#ff4fa3'], ['c_cyan', '네온 시안', 200, '#22d3ee'], ['c_mint', '민트', 200, '#34f5a0'], ['c_gold', '골드', 400, '#ffc83d'], ['c_violet', '바이올렛', 300, '#b57bff']]
  .forEach(function (a) { SHOP.push({ id: a[0], slot: 'color', name: a[1], price: a[2], value: a[3] }); });
SHOP.push({ id: 'f_glow', slot: 'fx', name: '네온 글로우', price: 600, value: 'glow' },
  { id: 'f_fire', slot: 'fx', name: '불타는 글자', price: 1800, value: 'fire' });
[['b_dice', '주사위', 150, '🎲'], ['b_clover', '네잎클로버', 300, '🍀'], ['b_fire', '불꽃', 300, '🔥'], ['b_gem', '다이아', 1200, '💎'], ['b_crown', '왕관', 2000, '👑']]
  .forEach(function (a) { SHOP.push({ id: a[0], slot: 'badge', name: a[1], price: a[2], value: a[3] }); });
var SHOP_BY_ID = {}; SHOP.forEach(function (i) { SHOP_BY_ID[i.id] = i; });
var SLOT_COL = { title: 'eq_title', color: 'eq_color', fx: 'eq_fx', badge: 'eq_badge' };
function deco(r) {
  function v(k) { var i = SHOP_BY_ID[r[k]]; return i ? i.value : null; }
  return { title: v('eq_title'), color: v('eq_color'), fx: v('eq_fx'), badge: v('eq_badge') };
}
function meView(u) {
  var o = { id: u.id, name: u.name, points: u.points, can_aid: u.points < CFG.MIN_BET && now() - (u.last_aid || 0) > 864e5,
    group_size: tbl('users').all().filter(function (x) { return grpOf(x) === grpOf(u); }).length };
  var d = deco(u); for (var k in d) o[k] = d[k];
  return o;
}

/* ================= 도박 ================= */
function sweep() {
  var due = function () { return tbl('bets').where(function (b) { return b.status === 'open' && b.closes_at && b.closes_at <= now(); }); };
  if (!due().length) return;
  var lock = null;
  if (!HOLDING) { lock = LockService.getScriptLock(); lock.waitLock(10000); }
  try {
    TBL.bets = null; // 락 잡은 뒤 최신 상태로 다시 읽기
    due().forEach(function (b) { b.status = 'closed'; tbl('bets').save(b); });
  } finally { if (lock) lock.releaseLock(); }
}
function groupBy(rows, key) { var m = {}; rows.forEach(function (r) { (m[r[key]] = m[r[key]] || []).push(r); }); return m; }

function betViews(bets, me) {
  var optsBy = groupBy(tbl('options').all(), 'bet_id'), wagBy = groupBy(tbl('wagers').all(), 'bet_id');
  var names = {}; tbl('users').all().forEach(function (u) { names[u.id] = u.name; });
  var chatBy = {}; tbl('messages').all().forEach(function (m) { chatBy[m.bet_id] = (chatBy[m.bet_id] || 0) + 1; });
  return bets.map(function (b) {
    var ws = wagBy[b.id] || [], total = ws.reduce(function (s, w) { return s + w.amount; }, 0);
    var mine = me ? ws.filter(function (w) { return w.user_id === me.id; }) : [];
    var done = b.status === 'resolved' || b.status === 'cancelled';
    return {
      id: b.id, title: b.title, creator: names[b.creator_id], mine_created: !!me && me.id === b.creator_id, status: b.status,
      winner: b.winner === '' ? null : b.winner, closes_at: b.closes_at === '' ? null : b.closes_at, created_at: b.created_at, total: total,
      options: (optsBy[b.id] || []).map(function (o) {
        var ow = ws.filter(function (w) { return w.option_id === o.id; }), pool = ow.reduce(function (s, w) { return s + w.amount; }, 0), share = total ? pool / total : 0;
        return { id: o.id, label: o.label, pool: pool, bettors: ow.length, share: share, multiplier: pool ? Math.round(total / pool * 100) / 100 : null,
          underdog: total > 0 && share < CFG.UNDERDOG_SHARE,
          my_amount: mine.filter(function (w) { return w.option_id === o.id; }).reduce(function (s, w) { return s + w.amount; }, 0) };
      }),
      my_payout: mine.length && done ? mine.reduce(function (s, w) { return s + (Number(w.payout) || 0); }, 0) : null,
      my_total: mine.reduce(function (s, w) { return s + w.amount; }, 0),
      my_lucky: mine.some(function (w) { return Number(w.lucky) === 1; }),
      chat_count: chatBy[b.id] || 0
    };
  });
}

function refund(w) { w.payout = w.amount; tbl('wagers').save(w); addPoints(w.user_id, w.amount); }

/** 파리뮤추얼 + 역배 보너스 + 럭키 보너스 (Node 버전과 동일 규칙) */
function settle(bet, winnerId) {
  var wagers = tbl('wagers').where(function (w) { return w.bet_id === bet.id; });
  var total = wagers.reduce(function (s, w) { return s + w.amount; }, 0);
  var winners = wagers.filter(function (w) { return w.option_id === winnerId; });
  var winPool = winners.reduce(function (s, w) { return s + w.amount; }, 0);
  if (winPool === 0 || winPool === total) { wagers.forEach(refund); return { refunded: true, total: total, underdog: false }; }
  var underdog = winPool / total < CFG.UNDERDOG_SHARE;
  var pot = total + (underdog ? Math.floor(total * CFG.UNDERDOG_BONUS) : 0), paid = 0;
  winners.forEach(function (w, i) {
    var base = i === winners.length - 1 && !underdog ? total - paid : Math.floor(pot * w.amount / winPool);
    paid += base;
    var lucky = Math.random() < CFG.LUCKY_CHANCE;
    var pay = base + (lucky ? Math.max(1, Math.floor(base * CFG.LUCKY_BONUS)) : 0);
    w.payout = pay; w.lucky = lucky ? 1 : 0; tbl('wagers').save(w); addPoints(w.user_id, pay);
  });
  wagers.forEach(function (w) { if (w.option_id !== winnerId) { w.payout = 0; tbl('wagers').save(w); } });
  return { refunded: false, total: total, underdog: underdog };
}

function betAction(bet, body) {
  if (bet.status === 'resolved' || bet.status === 'cancelled') fail(400, '이미 끝난 도박이에요.');
  if (body.action === 'close') { bet.status = 'closed'; tbl('bets').save(bet); return { ok: true }; }
  if (body.action === 'cancel') {
    tbl('wagers').where(function (w) { return w.bet_id === bet.id; }).forEach(refund);
    bet.status = 'cancelled'; tbl('bets').save(bet); return { ok: true };
  }
  if (body.action === 'resolve') {
    var oid = Number(body.option_id);
    var opt = tbl('options').find(function (o) { return o.id === oid && o.bet_id === bet.id; }) || fail(400, '정답 선택지를 골라주세요.');
    var r = settle(bet, opt.id);
    bet.status = r.refunded ? 'cancelled' : 'resolved'; bet.winner = r.refunded ? '' : opt.id; tbl('bets').save(bet);
    return { ok: true, refunded: r.refunded, total: r.total, underdog: r.underdog };
  }
  fail(400, '알 수 없는 동작이에요.');
}
function needLogin(u) { if (!u) fail(401, '로그인이 필요해요.'); return u; }
function betById(id) { return tbl('bets').find(function (b) { return b.id === Number(id); }) || fail(404, '도박이 없어요.'); }

function rankingView(me) {
  var wagers = tbl('wagers').all(), bets = {}; tbl('bets').all().forEach(function (b) { bets[b.id] = b.status; });
  return tbl('users').all().filter(function (x) { return grpOf(x) === grpOf(me); }).sort(function (a, b) { return b.points - a.points; }).slice(0, 50).map(function (u) {
    var mine = wagers.filter(function (w) { return w.user_id === u.id && bets[w.bet_id] === 'resolved'; });
    var o = { name: u.name, points: u.points, wins: mine.filter(function (w) { return w.payout > 0; }).length, losses: mine.filter(function (w) { return w.payout === 0; }).length };
    var d = deco(u); for (var k in d) o[k] = d[k];
    return o;
  });
}
function betsList(u) {
  var bets = tbl('bets').all().filter(function (b) { return sameRoom(b.creator_id, u); }).sort(function (a, b) {
    var ao = a.status === 'open' || a.status === 'closed' ? 1 : 0, bo = b.status === 'open' || b.status === 'closed' ? 1 : 0;
    return bo - ao || b.id - a.id;
  }).slice(0, 100);
  return betViews(bets, u);
}

/* ================= 가위바위보 ================= */
function withLock(fn) {
  if (HOLDING) return fn();
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}
/** 12시간 동안 아무도 안 온 방은 닫고 판돈 환불 */
function rpsSweep() {
  var old = function () { return tbl('rps').where(function (r) { return r.status === 'waiting' && r.created_at < now() - RPS.EXPIRE_MS; }); };
  if (!old().length) return;
  withLock(function () {
    TBL.rps = null; TBL.users = null;
    old().forEach(function (r) { addPoints(r.host_id, r.stake); r.status = 'cancelled'; tbl('rps').save(r); });
  });
}
function rpsPlayer(id) {
  var u = userById(id), o = { name: u ? u.name : '(탈퇴)' };
  if (u) { var d = deco(u); for (var k in d) o[k] = d[k]; }
  return o;
}
function rpsNet(r, myId) {
  if (r.host_id !== myId && r.guest_id !== myId) return null;
  if (r.result === 'draw') return 0;
  return (r.result === 'host') === (r.host_id === myId) ? r.stake : -r.stake;
}
function rpsView(u) {
  rpsSweep();
  var all = tbl('rps').all();
  var rooms = all.filter(function (r) { return r.status === 'waiting' && sameRoom(r.host_id, u); }).sort(function (a, b) { return b.id - a.id; }).slice(0, 30).map(function (r) {
    return { id: r.id, stake: r.stake, created_at: r.created_at, host: rpsPlayer(r.host_id), mine: r.host_id === u.id,
      my_hand: r.host_id === u.id ? r.host_hand : null }; // 방장의 손은 본인에게만 보임
  });
  var recent = all.filter(function (r) { return r.status === 'done' && sameRoom(r.host_id, u); }).sort(function (a, b) { return b.id - a.id; }).slice(0, 15).map(function (r) {
    return { id: r.id, stake: r.stake, host: rpsPlayer(r.host_id), guest: rpsPlayer(r.guest_id), host_hand: r.host_hand, guest_hand: r.guest_hand,
      result: r.result, at: r.played_at, mine: r.host_id === u.id || r.guest_id === u.id, net: rpsNet(r, u.id) };
  });
  return { rooms: rooms, recent: recent };
}

/* ================= 🤫 최저 유일 숫자 / 🪜 사다리타기 (여러 명이 방에 모여서 하는 게임) ================= */
// 게임 규칙(GAMES)은 Games.gs — Node 서버와 같은 파일
var ROOM_STAKE_MAX = 1000;
function playerView(id) { return rpsPlayer(id); }
function checkStake(raw) {
  var stake = Number(raw);
  if (stake !== Math.floor(stake) || stake < CFG.MIN_BET || stake > ROOM_STAKE_MAX) fail(400, '판돈은 ' + CFG.MIN_BET + '~' + ROOM_STAKE_MAX + '점이에요.');
  return stake;
}
function openRooms(table, uid) { return tbl(table).where(function (r) { return r.host_id === uid && r.status === 'waiting'; }).length; }
function byId(table, id) { id = Number(id); return tbl(table).find(function (r) { return r.id === id; }) || fail(404, '방이 없어요.'); }

/** 12시간 동안 다 안 모인 방은 닫고 모두에게 환불 */
function roomsSweep() {
  [['lun', 'lunp'], ['lad', 'ladp']].forEach(function (pair) {
    var old = function () { return tbl(pair[0]).where(function (r) { return r.status === 'waiting' && r.created_at < now() - RPS.EXPIRE_MS; }); };
    if (!old().length) return;
    withLock(function () {
      TBL[pair[0]] = null; TBL[pair[1]] = null; TBL.users = null;
      old().forEach(function (r) {
        tbl(pair[1]).where(function (p) { return p.room_id === r.id; }).forEach(function (p) { addPoints(p.user_id, r.stake); });
        r.status = 'cancelled'; tbl(pair[0]).save(r);
      });
    });
  });
}
function lunPlayers(room) { return tbl('lunp').where(function (p) { return p.room_id === room.id; }); }
function lunResolve(room) {
  var ps = lunPlayers(room), w = GAMES.lunWinner(ps.map(function (p) { return p.num; }));
  if (w < 0) ps.forEach(function (p) { addPoints(p.user_id, room.stake); });          // 전부 겹침 → 환불
  else addPoints(ps[w].user_id, room.stake * ps.length);                                // 승자가 판돈 전체
  room.status = 'done'; room.winner_id = w < 0 ? '' : ps[w].user_id; room.played_at = now(); tbl('lun').save(room);
}
function lunView(u) {
  roomsSweep();
  var all = tbl('lun').all();
  var rooms = all.filter(function (r) { return r.status === 'waiting' && sameRoom(r.host_id, u); }).sort(function (a, b) { return b.id - a.id; }).slice(0, 30).map(function (r) {
    var ps = lunPlayers(r), me = ps.filter(function (p) { return p.user_id === u.id; })[0];
    return { id: r.id, stake: r.stake, cap: r.cap, count: ps.length, host: playerView(r.host_id), players: ps.map(function (p) { return playerView(p.user_id); }),
      mine: r.host_id === u.id, joined: !!me, my_num: me ? me.num : null };           // 다른 사람의 숫자는 절대 안 보냄
  });
  var recent = all.filter(function (r) { return r.status === 'done' && sameRoom(r.host_id, u); }).sort(function (a, b) { return b.id - a.id; }).slice(0, 10).map(function (r) {
    var ps = lunPlayers(r), cnt = {}, me = ps.some(function (p) { return p.user_id === u.id; });
    ps.forEach(function (p) { cnt[p.num] = (cnt[p.num] || 0) + 1; });
    return { id: r.id, stake: r.stake, at: r.played_at, winner: r.winner_id ? playerView(r.winner_id) : null,
      players: ps.map(function (p) { var o = playerView(p.user_id); o.num = p.num; o.unique = cnt[p.num] === 1; return o; }), mine: me,
      net: !me ? null : !r.winner_id ? 0 : r.winner_id === u.id ? r.stake * (ps.length - 1) : -r.stake };
  });
  return { rooms: rooms, recent: recent, rules: GAMES.LUN };
}

function ladPlayers(room) { return tbl('ladp').where(function (p) { return p.room_id === room.id; }); }
function ladderResolve(room) {
  var ps = ladPlayers(room), rungs = GAMES.ladderMake(room.slots), winEnd = GAMES.ladderWinEnd(room.slots);
  var winner = ps.filter(function (p) { return GAMES.ladderEnd(rungs, p.slot) === winEnd; })[0];
  addPoints(winner.user_id, room.stake * room.slots);
  room.status = 'done'; room.rungs = JSON.stringify(rungs); room.win_end = winEnd; room.winner_id = winner.user_id; room.played_at = now(); tbl('lad').save(room);
}
function ladderView(u) {
  roomsSweep();
  var all = tbl('lad').all();
  var rooms = all.filter(function (r) { return r.status === 'waiting' && sameRoom(r.host_id, u); }).sort(function (a, b) { return b.id - a.id; }).slice(0, 30).map(function (r) {
    var ps = ladPlayers(r), bySlot = {};
    ps.forEach(function (p) { bySlot[p.slot] = p.user_id; });
    var seats = [];
    for (var i = 0; i < r.slots; i++) {
      if (bySlot[i] === undefined) seats.push(null); else { var o = playerView(bySlot[i]); o.mine = bySlot[i] === u.id; seats.push(o); }
    }
    return { id: r.id, stake: r.stake, slots: r.slots, host: playerView(r.host_id), mine: r.host_id === u.id, seats: seats, joined: ps.some(function (p) { return p.user_id === u.id; }) };
  });
  var recent = all.filter(function (r) { return r.status === 'done' && sameRoom(r.host_id, u); }).sort(function (a, b) { return b.id - a.id; }).slice(0, 10).map(function (r) {
    var rungs = JSON.parse(r.rungs), ps = ladPlayers(r).sort(function (a, b) { return a.slot - b.slot; }), me = ps.some(function (p) { return p.user_id === u.id; });
    return { id: r.id, stake: r.stake, slots: r.slots, at: r.played_at, win_end: r.win_end, rungs: rungs, winner: playerView(r.winner_id),
      seats: ps.map(function (p) { var o = playerView(p.user_id); o.slot = p.slot; o.end = GAMES.ladderEnd(rungs, p.slot); o.path = GAMES.ladderPath(rungs, p.slot); o.mine = p.user_id === u.id; return o; }),
      mine: me, net: !me ? null : r.winner_id === u.id ? r.stake * (r.slots - 1) : -r.stake };
  });
  return { rooms: rooms, recent: recent, rules: GAMES.LADDER };
}

/* ================= 🃏 블랙잭 / 🎰 슬롯머신 (서버 딜러와 하는 혼자 게임) ================= */
function checkBet(raw, min, max) {
  var bet = Number(raw);
  if (bet !== Math.floor(bet) || bet < min || bet > max) fail(400, '건 돈은 ' + min + '~' + max + '점이에요.');
  return bet;
}
function bjActive(uid) { return tbl('bj').find(function (r) { return r.user_id === uid && r.status === 'playing'; }); }
function bjSave(row, st) {
  row.state = JSON.stringify(st); row.status = st.status; row.outcome = st.outcome || ''; row.payout = st.payout;
  row.finished_at = st.status === 'done' ? now() : '';
  tbl('bj').save(row);
  if (st.status === 'done') addPoints(row.user_id, st.payout);
}
function bjView(u) {
  var mine = tbl('bj').where(function (r) { return r.user_id === u.id; });
  var row = bjActive(u.id) || mine[mine.length - 1] || null;
  var recent = mine.filter(function (r) { return r.status === 'done'; }).slice(-8).reverse().map(function (r) {
    var st = JSON.parse(r.state), w = st.bet * (st.doubled ? 2 : 1);
    return { outcome: r.outcome, wagered: w, net: r.payout - w };
  });
  var g = null;
  if (row) { g = GAMES.bjView(JSON.parse(row.state)); g.id = row.id; }
  return { game: g, recent: recent, rules: GAMES.BJ };
}
function slotView(u) {
  var recent = tbl('slots').where(function (r) { return r.user_id === u.id; }).slice(-8).reverse().map(function (r) {
    return { bet: r.bet, reels: JSON.parse(r.reels).map(function (i) { return GAMES.SLOT.SYMBOLS[i]; }), net: r.payout - r.bet };
  });
  return { recent: recent, symbols: GAMES.SLOT.SYMBOLS, triple: GAMES.SLOT.TRIPLE, cherry2: GAMES.SLOT.CHERRY2, cherry1: GAMES.SLOT.CHERRY1, min: GAMES.SLOT.MIN_BET, max: GAMES.SLOT.MAX_BET };
}

/* ================= API 경로 ================= */
var ROUTES = {
  'GET /api/state': function (body, u) { sweep(); return { me: u ? meView(u) : null, bets: u ? betsList(u) : [], ranking: u ? rankingView(u) : [], rps: u ? rpsView(u) : null }; },

  'POST /api/signup': function (body, u, ctx) {
    var name = checkName(body.name), pin = String(body.pin || '');
    if (!/^\d{4}$/.test(pin)) fail(400, 'PIN은 숫자 4자리예요.');
    if (tbl('users').find(function (x) { return x.name === name; })) fail(409, '이미 있는 닉네임이에요.');
    var salt = Utilities.getUuid().slice(0, 8);
    var nu = tbl('users').insert({ name: name, salt: salt, hash: hashPin(pin, salt), points: CFG.START_POINTS, last_aid: 0, created_at: now(), grp: groupKey(pin) });
    return { token: newSession(nu.id) };
  },
  'POST /api/login': function (body) {
    var name = String(body.name || '').trim(), pin = String(body.pin || '');
    throttle('login|' + name, 10);
    var u = tbl('users').find(function (x) { return x.name === name; });
    if (!u || hashPin(pin, u.salt) !== u.hash) fail(401, '닉네임 또는 PIN이 틀렸어요.');
    if (!u.grp) { u.grp = groupKey(pin); tbl('users').save(u); }   // 예전 계정은 처음 로그인할 때 방이 정해짐
    CacheService.getScriptCache().remove('login|' + name);
    return { token: newSession(u.id) };
  },
  // 닉네임이 있으면 로그인, 없으면 (확인 후) 가입 — 버튼 하나로 처리
  'POST /api/enter': function (body, u, ctx) {
    var name = String(body.name || '').trim();
    if (tbl('users').find(function (x) { return x.name === name; })) return ROUTES['POST /api/login'](body, u, ctx);
    if (!body.create) {
      checkName(name);
      if (!/^\d{4}$/.test(String(body.pin || ''))) fail(400, 'PIN은 숫자 4자리예요.');
      return { new_user: true };
    }
    return ROUTES['POST /api/signup'](body, u, ctx);
  },
  'POST /api/nickname': function (body, u) {
    needLogin(u); var name = checkName(body.name);
    var other = tbl('users').find(function (x) { return x.name === name; });
    if (other && other.id !== u.id) fail(409, '이미 있는 닉네임이에요.');
    u.name = name; tbl('users').save(u); return { ok: true };
  },
  'POST /api/bets': function (body, u) {
    needLogin(u);
    var title = String(body.title || '').trim();
    var labels = (Array.isArray(body.options) ? body.options : []).map(function (s) { return String(s).trim(); }).filter(Boolean);
    if (!title || title.length > 80) fail(400, '제목은 1~80자예요.');
    if (labels.length < 2 || labels.length > 6) fail(400, '선택지는 2~6개예요.');
    var uniq = {}; labels.forEach(function (l) { uniq[l] = 1; });
    if (Object.keys(uniq).length !== labels.length || labels.some(function (l) { return l.length > 40; })) fail(400, '선택지는 서로 달라야 하고 40자 이내예요.');
    var mins = Number(body.closes_in_minutes), closes = mins > 0 ? now() + Math.min(mins, 60 * 24 * 30) * 6e4 : '';
    var b = tbl('bets').insert({ title: title, creator_id: u.id, status: 'open', winner: '', closes_at: closes, created_at: now() });
    labels.forEach(function (l) { tbl('options').insert({ bet_id: b.id, label: l }); });
    return betViews([b], u)[0];
  },
  'POST /api/wager': function (body, u) {
    needLogin(u); sweep(); TBL.bets = null; // 마감 처리 후 최신 상태로
    var amount = Number(body.amount);
    if (amount !== Math.floor(amount) || !(amount >= CFG.MIN_BET)) fail(400, '최소 ' + CFG.MIN_BET + '점부터 걸 수 있어요.');
    var oid = Number(body.option_id);
    var opt = tbl('options').find(function (o) { return o.id === oid; }) || fail(404, '선택지가 없어요.');
    var bet = betById(opt.bet_id);
    if (!sameRoom(bet.creator_id, u)) fail(404, '도박이 없어요.');
    if (bet.status !== 'open') fail(400, '이미 마감된 도박이에요.');
    if (u.points < amount) fail(400, '포인트가 부족해요.');
    if (tbl('wagers').find(function (w) { return w.bet_id === bet.id && w.user_id === u.id && w.option_id !== opt.id; })) fail(400, '이 도박에는 이미 다른 선택지에 걸었어요.');
    u.points -= amount; tbl('users').save(u);
    tbl('wagers').insert({ bet_id: bet.id, option_id: opt.id, user_id: u.id, amount: amount, payout: '', lucky: 0, created_at: now() });
    return { ok: true };
  },
  'POST /api/bets/action': function (body, u) {
    needLogin(u); var bet = betById(body.bet_id);
    if (bet.creator_id !== u.id) fail(403, '도박을 연 사람만 할 수 있어요.');
    return betAction(bet, body);
  },
  'POST /api/aid': function (body, u) {
    needLogin(u);
    if (u.points >= CFG.MIN_BET) fail(400, '아직 포인트가 남아있어요.');
    if (now() - (u.last_aid || 0) < 864e5) fail(400, '구제금은 하루 한 번이에요.');
    u.points += CFG.DAILY_AID; u.last_aid = now(); tbl('users').save(u); return { ok: true };
  },

  // 채팅은 도박마다 따로: 목록에서 도박에 들어가서 그 안에서만 이야기해요
  'GET /api/chat': function (body, u, ctx) {
    needLogin(u);
    var betId = Number(ctx.qs.bet) || 0, after = Number(ctx.qs.after) || 0, names = {};
    if (!sameRoom(betById(betId).creator_id, u)) fail(404, '도박이 없어요.');
    tbl('users').all().forEach(function (x) { names[x.id] = x; });
    var rows = tbl('messages').all().filter(function (m) { return m.bet_id === betId && m.id > after && names[m.user_id]; });
    rows = after ? rows.slice(0, 100) : rows.slice(-60);
    return rows.map(function (m) {
      var o = { id: m.id, text: m.text, name: names[m.user_id].name, at: m.created_at, mine: m.user_id === u.id }, d = deco(names[m.user_id]);
      for (var k in d) o[k] = d[k];
      return o;
    });
  },
  'POST /api/chat': function (body, u) {
    needLogin(u);
    var bet = betById(body.bet_id);
    if (!sameRoom(bet.creator_id, u)) fail(404, '도박이 없어요.');
    var text = String(body.text || '').trim();
    if (!text || text.length > 200) fail(400, '메시지는 1~200자예요.');
    var last = tbl('messages').all().filter(function (m) { return m.user_id === u.id; }).pop();
    if (last && now() - last.created_at < 800) fail(429, '너무 빨라요! 잠깐만요.');
    tbl('messages').insert({ user_id: u.id, text: text, created_at: now(), bet_id: bet.id });
    var all = tbl('messages').all();
    if (all.length > 600) { tbl('messages').sheet.deleteRows(2, all.length - 400); TBL.messages = null; } // 오래된 건 정리
    return { ok: true };
  },

  'GET /api/rps': function (body, u) { needLogin(u); return rpsView(u); },
  'POST /api/rps/create': function (body, u) {
    needLogin(u);
    var hand = String(body.hand), stake = Number(body.stake);
    if (RPS.HANDS.indexOf(hand) < 0) fail(400, '가위·바위·보 중에 골라주세요.');
    if (stake !== Math.floor(stake) || !(stake >= CFG.MIN_BET)) fail(400, '판돈은 ' + CFG.MIN_BET + '점 이상이에요.');
    if (u.points < stake) fail(400, '포인트가 부족해요.');
    if (tbl('rps').where(function (r) { return r.host_id === u.id && r.status === 'waiting'; }).length >= RPS.MAX_OPEN) fail(400, '동시에 열 수 있는 방은 ' + RPS.MAX_OPEN + '개까지예요.');
    u.points -= stake; tbl('users').save(u);   // 판돈은 방을 여는 순간 맡겨짐
    var r = tbl('rps').insert({ host_id: u.id, stake: stake, host_hand: hand, guest_id: '', guest_hand: '', status: 'waiting', result: '', created_at: now(), played_at: '' });
    return { ok: true, id: r.id };
  },
  'POST /api/rps/join': function (body, u) {
    needLogin(u);
    var hand = String(body.hand);
    if (RPS.HANDS.indexOf(hand) < 0) fail(400, '가위·바위·보 중에 골라주세요.');
    var rid = Number(body.room_id);
    var r = tbl('rps').find(function (x) { return x.id === rid; }) || fail(404, '방이 없어요.');
    if (!sameRoom(r.host_id, u)) fail(404, '방이 없어요.');   // 다른 PIN 방의 가위바위보에는 못 들어옴
    if (r.status !== 'waiting') fail(400, '이미 끝났거나 닫힌 방이에요.');
    if (r.host_id === u.id) fail(400, '내가 만든 방에는 들어갈 수 없어요.');
    if (u.points < r.stake) fail(400, '포인트가 부족해요.');
    var result = r.host_hand === hand ? 'draw' : RPS.BEATS[r.host_hand] === hand ? 'host' : 'guest';
    // 방장은 판돈을 이미 냈고, 도전자는 지금 낸다. 이긴 쪽이 2배, 비기면 각자 환불.
    if (result === 'draw') addPoints(r.host_id, r.stake);
    else if (result === 'host') { addPoints(r.host_id, r.stake * 2); u.points -= r.stake; tbl('users').save(u); }
    else { u.points += r.stake; tbl('users').save(u); }
    r.guest_id = u.id; r.guest_hand = hand; r.status = 'done'; r.result = result; r.played_at = now(); tbl('rps').save(r);
    return { ok: true, id: r.id, host_hand: r.host_hand, guest_hand: hand, stake: r.stake, host: rpsPlayer(r.host_id),
      outcome: result === 'draw' ? 'draw' : result === 'guest' ? 'win' : 'lose', net: result === 'draw' ? 0 : result === 'guest' ? r.stake : -r.stake };
  },
  'POST /api/rps/cancel': function (body, u) {
    needLogin(u);
    var rid = Number(body.room_id);
    var r = tbl('rps').find(function (x) { return x.id === rid; }) || fail(404, '방이 없어요.');
    if (r.host_id !== u.id) fail(403, '방을 만든 사람만 닫을 수 있어요.');
    if (r.status !== 'waiting') fail(400, '이미 끝났거나 닫힌 방이에요.');
    u.points += r.stake; tbl('users').save(u);
    r.status = 'cancelled'; tbl('rps').save(r);
    return { ok: true };
  },

  /* ---- 🤫 최저 유일 숫자 ---- */
  'GET /api/lun': function (body, u) { needLogin(u); return lunView(u); },
  'POST /api/lun/create': function (body, u) {
    needLogin(u);
    var stake = checkStake(body.stake), cap = Number(body.cap), num = Number(body.num), L = GAMES.LUN;
    if (cap !== Math.floor(cap) || cap < L.MIN_PLAYERS || cap > L.MAX_PLAYERS) fail(400, '인원은 ' + L.MIN_PLAYERS + '~' + L.MAX_PLAYERS + '명이에요.');
    if (num !== Math.floor(num) || num < L.MIN || num > L.MAX) fail(400, '숫자는 ' + L.MIN + '~' + L.MAX + ' 중에 골라주세요.');
    if (u.points < stake) fail(400, '포인트가 부족해요.');
    if (openRooms('lun', u.id) >= RPS.MAX_OPEN) fail(400, '동시에 열 수 있는 방은 ' + RPS.MAX_OPEN + '개까지예요.');
    addPoints(u.id, -stake);
    var r = tbl('lun').insert({ host_id: u.id, stake: stake, cap: cap, status: 'waiting', winner_id: '', created_at: now(), played_at: '' });
    tbl('lunp').insert({ room_id: r.id, user_id: u.id, num: num, joined_at: now() });
    return { ok: true, id: r.id };
  },
  'POST /api/lun/join': function (body, u) {
    needLogin(u);
    var num = Number(body.num), L = GAMES.LUN;
    if (num !== Math.floor(num) || num < L.MIN || num > L.MAX) fail(400, '숫자는 ' + L.MIN + '~' + L.MAX + ' 중에 골라주세요.');
    var r = byId('lun', body.room_id);
    if (!sameRoom(r.host_id, u)) fail(404, '방이 없어요.');
    if (r.status !== 'waiting') fail(400, '이미 끝났거나 닫힌 방이에요.');
    var ps = lunPlayers(r);
    if (ps.some(function (p) { return p.user_id === u.id; })) fail(400, '이미 들어간 방이에요.');
    if (ps.length >= r.cap) fail(400, '자리가 다 찼어요.');
    if (userById(u.id).points < r.stake) fail(400, '포인트가 부족해요.');
    addPoints(u.id, -r.stake);
    tbl('lunp').insert({ room_id: r.id, user_id: u.id, num: num, joined_at: now() });
    var full = ps.length + 1 >= r.cap;
    if (full) lunResolve(r);
    return { ok: true, id: r.id, resolved: full };
  },
  'POST /api/lun/start': function (body, u) {   // 방장이 모인 사람들(3명 이상)로 먼저 시작
    needLogin(u);
    var r = byId('lun', body.room_id);
    if (r.host_id !== u.id) fail(403, '방을 만든 사람만 시작할 수 있어요.');
    if (r.status !== 'waiting') fail(400, '이미 끝났거나 닫힌 방이에요.');
    if (lunPlayers(r).length < GAMES.LUN.MIN_PLAYERS) fail(400, '최소 ' + GAMES.LUN.MIN_PLAYERS + '명이 모여야 시작할 수 있어요.');
    lunResolve(r);
    return { ok: true, id: r.id, resolved: true };
  },
  'POST /api/lun/cancel': function (body, u) {
    needLogin(u);
    var r = byId('lun', body.room_id);
    if (r.host_id !== u.id) fail(403, '방을 만든 사람만 닫을 수 있어요.');
    if (r.status !== 'waiting') fail(400, '이미 끝났거나 닫힌 방이에요.');
    lunPlayers(r).forEach(function (p) { addPoints(p.user_id, r.stake); });
    r.status = 'cancelled'; tbl('lun').save(r);
    return { ok: true };
  },

  /* ---- 🪜 사다리타기 ---- */
  'GET /api/ladder': function (body, u) { needLogin(u); return ladderView(u); },
  'POST /api/ladder/create': function (body, u) {
    needLogin(u);
    var stake = checkStake(body.stake), slots = Number(body.slots), slot = Number(body.slot), L = GAMES.LADDER;
    if (slots !== Math.floor(slots) || slots < L.MIN_SLOTS || slots > L.MAX_SLOTS) fail(400, '인원은 ' + L.MIN_SLOTS + '~' + L.MAX_SLOTS + '명이에요.');
    if (slot !== Math.floor(slot) || slot < 0 || slot >= slots) fail(400, '자리를 골라주세요.');
    if (u.points < stake) fail(400, '포인트가 부족해요.');
    if (openRooms('lad', u.id) >= RPS.MAX_OPEN) fail(400, '동시에 열 수 있는 방은 ' + RPS.MAX_OPEN + '개까지예요.');
    addPoints(u.id, -stake);
    var r = tbl('lad').insert({ host_id: u.id, stake: stake, slots: slots, status: 'waiting', win_end: '', rungs: '', winner_id: '', created_at: now(), played_at: '' });
    tbl('ladp').insert({ room_id: r.id, user_id: u.id, slot: slot, joined_at: now() });
    return { ok: true, id: r.id };
  },
  'POST /api/ladder/join': function (body, u) {
    needLogin(u);
    var slot = Number(body.slot), r = byId('lad', body.room_id);
    if (!sameRoom(r.host_id, u)) fail(404, '방이 없어요.');
    if (r.status !== 'waiting') fail(400, '이미 끝났거나 닫힌 방이에요.');
    if (slot !== Math.floor(slot) || slot < 0 || slot >= r.slots) fail(400, '자리를 골라주세요.');
    var ps = ladPlayers(r);
    if (ps.some(function (p) { return p.user_id === u.id; })) fail(400, '이미 들어간 방이에요.');
    if (ps.some(function (p) { return p.slot === slot; })) fail(400, '이미 다른 사람이 앉은 자리예요.');
    if (userById(u.id).points < r.stake) fail(400, '포인트가 부족해요.');
    addPoints(u.id, -r.stake);
    tbl('ladp').insert({ room_id: r.id, user_id: u.id, slot: slot, joined_at: now() });
    var full = ps.length + 1 >= r.slots;
    if (full) ladderResolve(r);          // 자리가 다 차는 순간 사다리를 만들어서 결판 (그 전엔 사다리가 존재하지 않음)
    return { ok: true, id: r.id, resolved: full };
  },
  'POST /api/ladder/cancel': function (body, u) {
    needLogin(u);
    var r = byId('lad', body.room_id);
    if (r.host_id !== u.id) fail(403, '방을 만든 사람만 닫을 수 있어요.');
    if (r.status !== 'waiting') fail(400, '이미 끝났거나 닫힌 방이에요.');
    ladPlayers(r).forEach(function (p) { addPoints(p.user_id, r.stake); });
    r.status = 'cancelled'; tbl('lad').save(r);
    return { ok: true };
  },

  /* ---- 🃏 블랙잭 ---- */
  'GET /api/blackjack': function (body, u) { needLogin(u); return bjView(u); },
  'POST /api/blackjack/start': function (body, u) {
    needLogin(u);
    var bet = checkBet(body.bet, GAMES.BJ.MIN_BET, GAMES.BJ.MAX_BET);
    if (bjActive(u.id)) fail(400, '진행 중인 판이 있어요. 먼저 끝내주세요.');
    if (u.points < bet) fail(400, '포인트가 부족해요.');
    addPoints(u.id, -bet);
    var st = GAMES.bjStart(bet);
    var row = tbl('bj').insert({ user_id: u.id, bet: bet, state: JSON.stringify(st), status: 'playing', outcome: '', payout: '', created_at: now(), finished_at: '' });
    bjSave(row, st);
    return bjView(userById(u.id));
  },

  /* ---- 🎰 슬롯머신 ---- */
  'GET /api/slots': function (body, u) { needLogin(u); return slotView(u); },
  'POST /api/slots/spin': function (body, u) {
    needLogin(u);
    var bet = checkBet(body.bet, GAMES.SLOT.MIN_BET, GAMES.SLOT.MAX_BET);
    if (u.points < bet) fail(400, '포인트가 부족해요.');
    var sp = GAMES.slotSpin(), payout = GAMES.slotPayout(bet, sp.mult);
    addPoints(u.id, payout - bet);
    tbl('slots').insert({ user_id: u.id, bet: bet, reels: JSON.stringify(sp.reels), payout: payout, created_at: now() });
    return { reels: sp.reels.map(function (i) { return GAMES.SLOT.SYMBOLS[i]; }), mult: sp.mult, bet: bet, payout: payout, net: payout - bet, points: userById(u.id).points };
  },

  'GET /api/shop': function (body, u) {
    needLogin(u);
    if (!CFG.SHOP_OPEN) return [];   // 닫혀 있으면 빈 목록 → 화면에 '준비 중' 표시
    var owned = {}; tbl('items').where(function (r) { return r.user_id === u.id; }).forEach(function (r) { owned[r.item_id] = 1; });
    return SHOP.map(function (i) { var o = {}; for (var k in i) o[k] = i[k]; o.owned = !!owned[i.id]; o.equipped = u[SLOT_COL[i.slot]] === i.id; return o; });
  },
  'POST /api/shop/buy': function (body, u) {
    needLogin(u);
    if (!CFG.SHOP_OPEN) fail(403, '상점은 아직 준비 중이에요.');
    var item = SHOP_BY_ID[String(body.item_id)] || fail(404, '없는 상품이에요.');
    if (tbl('items').find(function (r) { return r.user_id === u.id && r.item_id === item.id; })) fail(400, '이미 가지고 있어요.');
    if (u.points < item.price) fail(400, '포인트가 부족해요.');
    u.points -= item.price; u[SLOT_COL[item.slot]] = item.id; tbl('users').save(u); // 사면 바로 장착
    tbl('items').insert({ user_id: u.id, item_id: item.id });
    return { ok: true };
  },
  'POST /api/shop/equip': function (body, u) {
    needLogin(u);
    if (!CFG.SHOP_OPEN) fail(403, '상점은 아직 준비 중이에요.');
    if (body.item_id === null) {
      var col = SLOT_COL[String(body.slot)] || fail(400, '잘못된 칸이에요.');
      u[col] = ''; tbl('users').save(u); return { ok: true };
    }
    var item = SHOP_BY_ID[String(body.item_id)] || fail(404, '없는 상품이에요.');
    if (!tbl('items').find(function (r) { return r.user_id === u.id && r.item_id === item.id; })) fail(400, '먼저 구매해야 해요.');
    u[SLOT_COL[item.slot]] = item.id; tbl('users').save(u); return { ok: true };
  },

  /* ---- 관리자 ---- */
  'GET /api/admin/overview': function (body, u, ctx) {
    adminOnly(ctx); sweep();
    var users = tbl('users').all().slice().sort(function (a, b) { return b.points - a.points; }).map(function (x) { return { id: x.id, name: x.name, points: x.points, created_at: x.created_at, grp: x.grp ? String(x.grp).slice(0, 4) : null }; });
    var wag = tbl('wagers').all(), names = {}; tbl('users').all().forEach(function (x) { names[x.id] = x.name; });
    var bets = betViews(tbl('bets').all().slice().sort(function (a, b) { return b.id - a.id; }).slice(0, 200), null);
    var titles = {}; tbl('bets').all().forEach(function (b) { titles[b.id] = b.title; });
    var messages = tbl('messages').all().filter(function (m) { return names[m.user_id]; }).slice(-40).reverse().map(function (m) { return { id: m.id, text: m.text, created_at: m.created_at, name: names[m.user_id], bet_title: titles[m.bet_id] || null }; });
    return { users: users, bets: bets, messages: messages, stats: {
      users: users.length, points: users.reduce(function (s, x) { return s + x.points; }, 0), wagers: wag.length,
      wagered: wag.reduce(function (s, w) { return s + w.amount; }, 0), lucky: wag.filter(function (w) { return Number(w.lucky) === 1; }).length } };
  },
  'POST /api/admin/user': function (body, u, ctx) {
    adminOnly(ctx);
    var t = tbl('users').find(function (x) { return x.id === Number(body.user_id); }) || fail(404, '유저가 없어요.');
    var v = Number(body.value);
    if (body.action === 'set_points' || body.action === 'add_points') {
      if (v !== Math.floor(v)) fail(400, '숫자를 넣어주세요.');
      var next = body.action === 'set_points' ? v : t.points + v;
      if (next < 0) fail(400, '0점 미만으로는 못 해요.');
      t.points = next; tbl('users').save(t);
    } else if (body.action === 'rename') {
      var name = checkName(body.value);
      if (tbl('users').find(function (x) { return x.name === name && x.id !== t.id; })) fail(409, '이미 있는 닉네임이에요.');
      t.name = name; tbl('users').save(t);
    } else if (body.action === 'reset_pin') {
      var pin = String(body.value || '');
      if (!/^\d{4}$/.test(pin)) fail(400, 'PIN은 숫자 4자리예요.');
      var salt = Utilities.getUuid().slice(0, 8); t.salt = salt; t.hash = hashPin(pin, salt); t.grp = groupKey(pin); tbl('users').save(t);   // PIN이 바뀌면 방도 바뀜
      var keys = tbl('sessions').where(function (s) { return s.user_id === t.id; }).map(function (s) { return 's_' + s.token; });
      if (keys.length) CacheService.getScriptCache().removeAll(keys);
      tbl('sessions').removeWhere(function (s) { return s.user_id === t.id; });
    } else if (body.action === 'delete') {
      var active = {}; tbl('bets').all().forEach(function (b) { if (b.status === 'open' || b.status === 'closed') active[b.id] = 1; });
      if (tbl('wagers').find(function (w) { return w.user_id === t.id && active[w.bet_id]; })) fail(400, '진행 중인 도박에 건 돈이 있어서 못 지워요. 그 도박을 먼저 정리해주세요.');
      var waitingLun = {}, waitingLad = {};
      tbl('lun').all().forEach(function (r) { if (r.status === 'waiting') waitingLun[r.id] = 1; });
      tbl('lad').all().forEach(function (r) { if (r.status === 'waiting') waitingLad[r.id] = 1; });
      if (tbl('lunp').find(function (p) { return p.user_id === t.id && waitingLun[p.room_id]; }) || tbl('ladp').find(function (p) { return p.user_id === t.id && waitingLad[p.room_id]; }) || bjActive(t.id)) fail(400, '진행 중인 게임이 있어서 못 지워요. 끝나거나 닫힌 뒤에 지워주세요.');
      tbl('rps').where(function (r) { return r.host_id === t.id && r.status === 'waiting'; }).forEach(function (r) { r.status = 'cancelled'; tbl('rps').save(r); });
      tbl('sessions').removeWhere(function (s) { return s.user_id === t.id; });
      tbl('messages').removeWhere(function (m) { return m.user_id === t.id; });
      tbl('items').removeWhere(function (r) { return r.user_id === t.id; });
      tbl('users').remove(t);
    } else fail(400, '알 수 없는 동작이에요.');
    return { ok: true };
  },
  'POST /api/admin/bet': function (body, u, ctx) {
    adminOnly(ctx); var bet = betById(body.bet_id);
    if (body.action === 'delete') {
      if (bet.status === 'open' || bet.status === 'closed') tbl('wagers').where(function (w) { return w.bet_id === bet.id; }).forEach(refund);
      tbl('wagers').removeWhere(function (w) { return w.bet_id === bet.id; });
      tbl('options').removeWhere(function (o) { return o.bet_id === bet.id; });
      tbl('messages').removeWhere(function (m) { return m.bet_id === bet.id; });
      tbl('bets').remove(bet); return { ok: true };
    }
    return betAction(bet, body);
  },
  'POST /api/admin/gift': function (body, u, ctx) {
    adminOnly(ctx); var v = Number(body.amount);
    if (v !== Math.floor(v) || v <= 0 || v > 1e6) fail(400, '1~1000000 사이 정수를 넣어주세요.');
    tbl('users').all().forEach(function (x) { x.points += v; tbl('users').save(x); });
    return { ok: true };
  },
  'POST /api/admin/chat': function (body, u, ctx) {
    adminOnly(ctx);
    var m = tbl('messages').find(function (x) { return x.id === Number(body.id); });
    if (m) tbl('messages').remove(m);
    return { ok: true };
  }
};

['hit', 'stand', 'double'].forEach(function (act) {
  ROUTES['POST /api/blackjack/' + act] = function (body, u) {
    needLogin(u);
    var row = bjActive(u.id) || fail(400, '진행 중인 판이 없어요. 새로 시작해주세요.');
    var st = JSON.parse(row.state);
    if (act === 'double') {
      if (!GAMES.bjCanDouble(st)) fail(400, '더블다운은 처음 카드 두 장일 때만 할 수 있어요.');
      if (userById(u.id).points < st.bet) fail(400, '더블다운할 포인트가 부족해요.');
      addPoints(u.id, -st.bet);                                  // 추가로 같은 금액을 더 걸어요
      GAMES.bjDouble(st);
    } else if (act === 'hit') GAMES.bjHit(st); else GAMES.bjStand(st);
    bjSave(row, st);
    return bjView(userById(u.id));
  };
});

/* ================= 설치 도우미 ================= */
/** 한 번 실행하세요: 시트 탭을 만들고, '관리자' 탭에 관리자 링크를 적어줍니다. */
function showAdminLink() {
  Object.keys(SHEETS).forEach(function (n) { tbl(n); });
  var url = ''; try { url = ScriptApp.getService().getUrl(); } catch (e) {}
  var link = (url || '(웹 앱 주소)') + '?admin=' + secret('ADMIN_KEY');
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName('관리자') || ss.insertSheet('관리자');
  sh.clear(); sh.getRange('A1').setValue('관리자 링크 (나만 알고 있기!)'); sh.getRange('A2').setValue(link);
  sh.getRange('A4').setValue('웹 앱 주소가 비어 있으면, 배포 후 나온 주소 뒤에 ?admin=' + secret('ADMIN_KEY') + ' 를 붙이세요.');
  Logger.log(link);
}
