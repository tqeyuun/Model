// 친구들끼리 쓰는 포인트 도박 사이트. 외부 패키지 없음 (Node 22+).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const G = require('./games-core');   // 게임 규칙 (구글 앱스 스크립트 버전과 같은 파일)

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.db');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const TOKENINFO_URL = process.env.GOOGLE_TOKENINFO_URL || 'https://oauth2.googleapis.com/tokeninfo';
const RPS_HANDS = ['rock', 'paper', 'scissors'];           // 바위 보 가위
const RPS_BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
const RPS_EXPIRE_MS = 12 * 3600e3;                           // 12시간 동안 아무도 안 오면 방이 닫히고 판돈 환불
const RPS_MAX_OPEN = 3;                                      // 한 사람이 동시에 열 수 있는 방 수
let SHOP_OPEN = process.env.SHOP_OPEN === '1';        // 상점 열기/닫기 (닫혀 있으면 구매·장착 불가). 열려면 SHOP_OPEN=1
const START_POINTS = 1000;
const MIN_BET = 10;
const DAILY_AID = 100;          // 파산 구제금(포인트가 MIN_BET 미만일 때, 하루 1회)
const UNDERDOG_SHARE = 0.30;    // 이긴 쪽 판돈 비중이 이 값 미만이면 역배
const UNDERDOG_BONUS = 0.20;    // 역배 적중 시 총 판돈의 20%를 보너스로 추가 지급
let LUCKY_CHANCE = Number(process.env.LUCKY_CHANCE ?? 0.07); // 이긴 사람마다 7% 확률로 럭키 보너스
const LUCKY_BONUS = 0.5;        // 럭키 당첨 시 받은 금액의 50%를 추가 지급

const db = new DatabaseSync(DB_FILE);
// 방 코드 + 방별 닉네임 구조로 바뀐 첫 실행: 예전 계정·방·기록은 전부 비워요 (관리자 설정은 유지)
const SCHEMA_V = '2';
db.exec('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
if (db.prepare("SELECT v FROM settings WHERE k='schema_v'").get()?.v !== SCHEMA_V) {
  for (const t of ['users', 'sessions', 'bets', 'options', 'wagers', 'messages', 'user_items', 'rps', 'lun', 'lun_p', 'lad', 'lad_p', 'bj', 'slots', 'rooms']) db.exec(`DROP TABLE IF EXISTS ${t}`);
  db.prepare("INSERT OR REPLACE INTO settings(k,v) VALUES ('schema_v', ?)").run(SCHEMA_V);
}
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
  points INTEGER NOT NULL, last_aid INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY, grp TEXT UNIQUE NOT NULL, code TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, creator_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',  -- open | closed | resolved | cancelled
  winner INTEGER, closes_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS options (id INTEGER PRIMARY KEY, bet_id INTEGER NOT NULL, label TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rps (
  id INTEGER PRIMARY KEY, host_id INTEGER NOT NULL, stake INTEGER NOT NULL, host_hand TEXT NOT NULL,
  guest_id INTEGER, guest_hand TEXT, status TEXT NOT NULL DEFAULT 'waiting',  -- waiting | done | cancelled
  result TEXT, created_at INTEGER NOT NULL, played_at INTEGER);  -- result: host | guest | draw
CREATE TABLE IF NOT EXISTS lun (id INTEGER PRIMARY KEY, host_id INTEGER NOT NULL, stake INTEGER NOT NULL, cap INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting', winner_id INTEGER, created_at INTEGER NOT NULL, played_at INTEGER);      -- waiting | done | cancelled
CREATE TABLE IF NOT EXISTS lun_p (id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL, user_id INTEGER NOT NULL, num INTEGER NOT NULL, joined_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lad (id INTEGER PRIMARY KEY, host_id INTEGER NOT NULL, stake INTEGER NOT NULL, slots INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting', win_end INTEGER, rungs TEXT, winner_id INTEGER, created_at INTEGER NOT NULL, played_at INTEGER);
CREATE TABLE IF NOT EXISTS lad_p (id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL, user_id INTEGER NOT NULL, slot INTEGER NOT NULL, joined_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bj (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, bet INTEGER NOT NULL, state TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'playing', outcome TEXT, payout INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE TABLE IF NOT EXISTS slots (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, bet INTEGER NOT NULL, reels TEXT NOT NULL, payout INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wagers (
  id INTEGER PRIMARY KEY, bet_id INTEGER NOT NULL, option_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL, payout INTEGER, created_at INTEGER NOT NULL);
`);

try { db.exec('ALTER TABLE messages ADD COLUMN bet_id INTEGER NOT NULL DEFAULT 0'); } catch { /* 이미 있음 */ }
try { db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT'); } catch { /* 이미 있음 */ }
try { db.exec('ALTER TABLE users ADD COLUMN grp TEXT'); } catch { /* 이미 있음 */ }
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_room_name ON users(grp, name)');   // 닉네임은 방 안에서만 겹치지 않으면 됨
for (const c of ['eq_title', 'eq_color', 'eq_fx', 'eq_badge']) { try { db.exec(`ALTER TABLE users ADD COLUMN ${c} TEXT`); } catch { /* 이미 있음 */ } }
db.exec('CREATE TABLE IF NOT EXISTS user_items (user_id INTEGER NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY(user_id, item_id))');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google ON users(google_sub)');
try { db.exec('ALTER TABLE wagers ADD COLUMN lucky INTEGER NOT NULL DEFAULT 0'); } catch { /* 이미 있음 */ }

// 관리자 키: ADMIN_KEY 환경변수가 있으면 그것, 없으면 최초 실행 때 생성해 DB에 저장
let ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) {
  ADMIN_KEY = db.prepare("SELECT v FROM settings WHERE k='admin_key'").get()?.v;
  if (!ADMIN_KEY) {
    ADMIN_KEY = require('node:crypto').randomBytes(18).toString('hex');
    db.prepare("INSERT INTO settings VALUES ('admin_key', ?)").run(ADMIN_KEY);
  }
}
// ---------- 상점 ----------
// slot: title(호칭) | color(닉네임 색) | fx(닉네임 효과) | badge(이름 앞 이모지)
const SHOP = [
  ...[['t_gambler', '도박꾼', 300], ['t_dog', '역배 장인', 500], ['t_lucky', '행운아', 800], ['t_whale', '큰손', 1500], ['t_oracle', '예언가', 2500], ['t_legend', '전설', 5000]]
    .map(([id, name, price]) => ({ id, slot: 'title', name, price, value: name })),
  ...[['c_pink', '네온 핑크', 200, '#ff4fa3'], ['c_cyan', '네온 시안', 200, '#22d3ee'], ['c_mint', '민트', 200, '#34f5a0'], ['c_gold', '골드', 400, '#ffc83d'], ['c_violet', '바이올렛', 300, '#b57bff']]
    .map(([id, name, price, value]) => ({ id, slot: 'color', name, price, value })),
  { id: 'f_glow', slot: 'fx', name: '네온 글로우', price: 600, value: 'glow' },
  { id: 'f_fire', slot: 'fx', name: '불타는 글자', price: 1800, value: 'fire' },
  ...[['b_dice', '주사위', 150, '🎲'], ['b_clover', '네잎클로버', 300, '🍀'], ['b_fire', '불꽃', 300, '🔥'], ['b_gem', '다이아', 1200, '💎'], ['b_crown', '왕관', 2000, '👑']]
    .map(([id, name, price, value]) => ({ id, slot: 'badge', name, price, value })),
];
const SHOP_BY_ID = Object.fromEntries(SHOP.map((i) => [i.id, i]));
const SLOT_COL = { title: 'eq_title', color: 'eq_color', fx: 'eq_fx', badge: 'eq_badge' };
const deco = (r) => ({ title: SHOP_BY_ID[r.eq_title]?.value || null, color: SHOP_BY_ID[r.eq_color]?.value || null, fx: SHOP_BY_ID[r.eq_fx]?.value || null, badge: SHOP_BY_ID[r.eq_badge]?.value || null });
const now = () => Date.now();
const q = (sql, ...a) => db.prepare(sql).all(...a);
const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const tx = (fn) => {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

// ---------- 정산 ----------
// 파리뮤추얼: 진 쪽 판돈 + 이긴 쪽 판돈을 이긴 사람들이 건 금액 비례로 나눠 가짐.
// 소수 의견(역배)은 판돈이 적으니 배당이 자연스럽게 커지고, 비중이 30% 미만이면 보너스까지.
function settle(bet, winnerOptionId) {
  const wagers = q('SELECT * FROM wagers WHERE bet_id=?', bet.id);
  const total = wagers.reduce((s, w) => s + w.amount, 0);
  const winners = wagers.filter((w) => w.option_id === winnerOptionId);
  const winPool = winners.reduce((s, w) => s + w.amount, 0);
  if (winPool === 0 || winPool === total) {
    // 아무도 못 맞혔거나 전원이 같은 쪽: 도박 성립 안 됨 → 환불
    for (const w of wagers) refund(w);
    return { refunded: true, total, underdog: false };
  }
  const underdog = winPool / total < UNDERDOG_SHARE;
  const pot = total + (underdog ? Math.floor(total * UNDERDOG_BONUS) : 0);
  let paid = 0;
  winners.forEach((w, i) => {
    const base = i === winners.length - 1 && !underdog ? total - paid : Math.floor((pot * w.amount) / winPool);
    paid += base;
    const lucky = Math.random() < LUCKY_CHANCE;
    const pay = base + (lucky ? Math.max(1, Math.floor(base * LUCKY_BONUS)) : 0);
    run('UPDATE wagers SET payout=?, lucky=? WHERE id=?', pay, lucky ? 1 : 0, w.id);
    run('UPDATE users SET points=points+? WHERE id=?', pay, w.user_id);
  });
  for (const w of wagers) if (w.option_id !== winnerOptionId) run('UPDATE wagers SET payout=0 WHERE id=?', w.id);
  return { refunded: false, total, underdog };
}
function refund(w) {
  run('UPDATE wagers SET payout=? WHERE id=?', w.amount, w.id);
  run('UPDATE users SET points=points+? WHERE id=?', w.amount, w.user_id);
}

// 마감 시간이 지난 open 도박은 closed 로 전환
function sweep() { run("UPDATE bets SET status='closed' WHERE status='open' AND closes_at IS NOT NULL AND closes_at<=?", now()); }

// ---------- 가위바위보 ----------
function rpsSweep() {
  const old = q("SELECT * FROM rps WHERE status='waiting' AND created_at<?", now() - RPS_EXPIRE_MS);
  if (!old.length) return;
  tx(() => { for (const r of old) { run('UPDATE users SET points=points+? WHERE id=?', r.stake, r.host_id); run("UPDATE rps SET status='cancelled' WHERE id=?", r.id); } });
}
function rpsPlayer(id) {
  const u = q1('SELECT name,eq_title,eq_color,eq_fx,eq_badge FROM users WHERE id=?', id);
  return u ? { name: u.name, ...deco(u) } : { name: '(탈퇴)' };
}
const rpsNet = (r, myId) => {
  if (r.host_id !== myId && r.guest_id !== myId) return null;
  if (r.result === 'draw') return 0;
  return (r.result === 'host') === (r.host_id === myId) ? r.stake : -r.stake;
};
function rpsView(u) {
  rpsSweep();
  const rooms = q("SELECT r.* FROM rps r JOIN users h ON h.id=r.host_id WHERE r.status='waiting' AND h.grp IS ? ORDER BY r.id DESC LIMIT 30", grpOf(u)).map((r) => ({
    id: r.id, stake: r.stake, created_at: r.created_at, host: rpsPlayer(r.host_id), mine: r.host_id === u.id,
    my_hand: r.host_id === u.id ? r.host_hand : null,   // 방장의 손은 본인에게만 보임
  }));
  const recent = q("SELECT r.* FROM rps r JOIN users h ON h.id=r.host_id WHERE r.status='done' AND h.grp IS ? ORDER BY r.id DESC LIMIT 15", grpOf(u)).map((r) => ({
    id: r.id, stake: r.stake, host: rpsPlayer(r.host_id), guest: rpsPlayer(r.guest_id), host_hand: r.host_hand, guest_hand: r.guest_hand,
    result: r.result, at: r.played_at, mine: r.host_id === u.id || r.guest_id === u.id, net: rpsNet(r, u.id),
  }));
  return { rooms, recent };
}

// ---------- 🤫 최저 유일 숫자 / 🪜 사다리타기 (여러 명이 방에 모여서 하는 게임) ----------
let ROOM_STAKE_MAX = 1000;
const playerView = (id) => rpsPlayer(id);
const pay = (userId, delta) => run('UPDATE users SET points=points+? WHERE id=?', delta, userId);
function checkStake(raw) {
  const stake = Number(raw);
  if (!Number.isInteger(stake) || stake < MIN_BET || stake > ROOM_STAKE_MAX) fail(400, `판돈은 ${MIN_BET}~${ROOM_STAKE_MAX}점이에요.`);
  return stake;
}
const DUP_MS = 5000;   // 같은 사람이 같은 조건의 방/도박을 이 시간 안에 또 만들면 연타로 보고 거절
const isDup = (sql, ...a) => !!q1(sql + ' AND created_at>?', ...a, now() - DUP_MS);
const openRooms = (table, uid) => q1(`SELECT COUNT(*) n FROM ${table} WHERE host_id=? AND status='waiting'`, uid).n;
const sameRoomHost = (hostId, u) => { const h = q1('SELECT grp FROM users WHERE id=?', hostId); return !!h && (h.grp || null) === grpOf(u); };

// 12시간 동안 다 안 모인 방은 닫고 모두에게 환불
function roomsSweep() {
  for (const [table, pt, col] of [['lun', 'lun_p', 'room_id'], ['lad', 'lad_p', 'room_id']]) {
    const old = q(`SELECT * FROM ${table} WHERE status='waiting' AND created_at<?`, now() - RPS_EXPIRE_MS);
    if (!old.length) continue;
    tx(() => { for (const r of old) { for (const p of q(`SELECT user_id FROM ${pt} WHERE ${col}=?`, r.id)) pay(p.user_id, r.stake); run(`UPDATE ${table} SET status='cancelled' WHERE id=?`, r.id); } });
  }
}
function lunResolve(room) {
  const ps = q('SELECT * FROM lun_p WHERE room_id=? ORDER BY id', room.id);
  const w = G.lunWinner(ps.map((p) => p.num));
  if (w < 0) for (const p of ps) pay(p.user_id, room.stake);                  // 전부 겹침 → 환불
  else pay(ps[w].user_id, room.stake * ps.length);                              // 승자가 판돈 전체
  run("UPDATE lun SET status='done', winner_id=?, played_at=? WHERE id=?", w < 0 ? null : ps[w].user_id, now(), room.id);
}
function lunView(u) {
  roomsSweep();
  const rooms = q("SELECT r.* FROM lun r JOIN users h ON h.id=r.host_id WHERE r.status='waiting' AND h.grp IS ? ORDER BY r.id DESC LIMIT 30", grpOf(u)).map((r) => {
    const ps = q('SELECT user_id,num FROM lun_p WHERE room_id=? ORDER BY id', r.id), me = ps.find((p) => p.user_id === u.id);
    return { id: r.id, stake: r.stake, cap: r.cap, count: ps.length, host: playerView(r.host_id), players: ps.map((p) => playerView(p.user_id)),
      mine: r.host_id === u.id, joined: !!me, my_num: me ? me.num : null };           // 다른 사람의 숫자는 절대 안 보냄
  });
  const recent = q("SELECT r.* FROM lun r JOIN users h ON h.id=r.host_id WHERE r.status='done' AND h.grp IS ? ORDER BY r.id DESC LIMIT 10", grpOf(u)).map((r) => {
    const ps = q('SELECT user_id,num FROM lun_p WHERE room_id=? ORDER BY id', r.id), me = ps.some((p) => p.user_id === u.id);
    const cnt = {}; ps.forEach((p) => { cnt[p.num] = (cnt[p.num] || 0) + 1; });
    return { id: r.id, stake: r.stake, at: r.played_at, winner: r.winner_id ? playerView(r.winner_id) : null,
      players: ps.map((p) => ({ ...playerView(p.user_id), num: p.num, unique: cnt[p.num] === 1 })), mine: me,
      net: !me ? null : !r.winner_id ? 0 : r.winner_id === u.id ? r.stake * (ps.length - 1) : -r.stake };
  });
  return { rooms, recent, rules: G.LUN };
}

function ladderResolve(room) {
  const ps = q('SELECT * FROM lad_p WHERE room_id=? ORDER BY slot', room.id);
  const rungs = G.ladderMake(room.slots), winEnd = G.ladderWinEnd(room.slots);
  const winner = ps.find((p) => G.ladderEnd(rungs, p.slot) === winEnd);
  pay(winner.user_id, room.stake * room.slots);
  run("UPDATE lad SET status='done', rungs=?, win_end=?, winner_id=?, played_at=? WHERE id=?", JSON.stringify(rungs), winEnd, winner.user_id, now(), room.id);
}
function ladderView(u) {
  roomsSweep();
  const rooms = q("SELECT r.* FROM lad r JOIN users h ON h.id=r.host_id WHERE r.status='waiting' AND h.grp IS ? ORDER BY r.id DESC LIMIT 30", grpOf(u)).map((r) => {
    const ps = q('SELECT user_id,slot FROM lad_p WHERE room_id=?', r.id), bySlot = {};
    ps.forEach((p) => { bySlot[p.slot] = p.user_id; });
    return { id: r.id, stake: r.stake, slots: r.slots, host: playerView(r.host_id), mine: r.host_id === u.id,
      seats: Array.from({ length: r.slots }, (_, i) => (bySlot[i] === undefined ? null : { ...playerView(bySlot[i]), mine: bySlot[i] === u.id })),
      joined: ps.some((p) => p.user_id === u.id) };
  });
  const recent = q("SELECT r.* FROM lad r JOIN users h ON h.id=r.host_id WHERE r.status='done' AND h.grp IS ? ORDER BY r.id DESC LIMIT 10", grpOf(u)).map((r) => {
    const ps = q('SELECT user_id,slot FROM lad_p WHERE room_id=? ORDER BY slot', r.id), rungs = JSON.parse(r.rungs);
    return { id: r.id, stake: r.stake, slots: r.slots, at: r.played_at, win_end: r.win_end, rungs, winner: playerView(r.winner_id),
      seats: ps.map((p) => ({ ...playerView(p.user_id), slot: p.slot, end: G.ladderEnd(rungs, p.slot), path: G.ladderPath(rungs, p.slot), mine: p.user_id === u.id })),
      mine: ps.some((p) => p.user_id === u.id), net: !ps.some((p) => p.user_id === u.id) ? null : r.winner_id === u.id ? r.stake * (r.slots - 1) : -r.stake };
  });
  return { rooms, recent, rules: G.LADDER };
}

// ---------- 🃏 블랙잭 / 🎰 슬롯머신 (서버 딜러와 하는 혼자 게임) ----------
// 오늘(한국 시간) 혼자 하는 게임(블랙잭+슬롯)에서 번 순이익과 한 판 수
function soloToday(uid) {
  const ds = G.dayStart(now());
  let net = 0;
  for (const r of q('SELECT bet, payout FROM slots WHERE user_id=? AND created_at>=?', uid, ds)) net += r.payout - r.bet;
  for (const r of q("SELECT state, payout FROM bj WHERE user_id=? AND status='done' AND finished_at>=?", uid, ds)) { const st = JSON.parse(r.state); net += r.payout - st.bet * (st.doubled ? 2 : 1); }
  const plays = q('SELECT COUNT(*) n FROM slots WHERE user_id=? AND created_at>=?', uid, ds)[0].n + q('SELECT COUNT(*) n FROM bj WHERE user_id=? AND created_at>=?', uid, ds)[0].n;
  return { net, plays };
}
const soloLimits = (uid) => { const t = soloToday(uid); return G.soloLimits(t.net, t.plays); };
function soloGuard(uid) {   // 새 판을 시작하기 전에: 오늘 한도에 닿았으면 막음
  const l = soloLimits(uid);
  if (l.blocked) fail(400, G.soloBlockedMessage(l));
}
const bjActive = (uid) => q1("SELECT * FROM bj WHERE user_id=? AND status='playing'", uid);
function bjSave(row, st) {
  if (st.status === 'done') {   // 오늘 한도를 넘게 따면 한도까지만 지급
    const w = st.bet * (st.doubled ? 2 : 1), net = st.payout - w;
    if (net > 0) { const allowed = G.soloClampWin(net, soloToday(row.user_id).net); if (allowed < net) { st.payout = w + allowed; st.capped = true; } }
  }
  run('UPDATE bj SET state=?, status=?, outcome=?, payout=?, finished_at=? WHERE id=?', JSON.stringify(st), st.status, st.outcome, st.payout, st.status === 'done' ? now() : null, row.id);
  if (st.status === 'done') pay(row.user_id, st.payout);
}
function bjView(u) {
  const row = bjActive(u.id) || q1("SELECT * FROM bj WHERE user_id=? ORDER BY id DESC LIMIT 1", u.id);
  const recent = q("SELECT bet, state, outcome, payout FROM bj WHERE user_id=? AND status='done' ORDER BY id DESC LIMIT 8", u.id).map((r) => {
    const st = JSON.parse(r.state), w = st.bet * (st.doubled ? 2 : 1);
    return { outcome: r.outcome, wagered: w, net: r.payout - w };
  });
  return { game: row ? { id: row.id, ...G.bjView(JSON.parse(row.state)) } : null, recent, rules: G.BJ, limits: soloLimits(u.id) };
}
function slotView(u) {
  const recent = q('SELECT bet, reels, payout FROM slots WHERE user_id=? ORDER BY id DESC LIMIT 8', u.id).map((r) => ({ bet: r.bet, reels: JSON.parse(r.reels).map((i) => G.SLOT.SYMBOLS[i]), net: r.payout - r.bet }));
  return { recent, symbols: G.SLOT.SYMBOLS, triple: G.SLOT.TRIPLE, cherry2: G.SLOT.CHERRY2, cherry1: G.SLOT.CHERRY1, min: G.SLOT.MIN_BET, max: G.SLOT.MAX_BET, limits: soloLimits(u.id) };
}
function checkBet(raw, min, max) {
  const bet = Number(raw);
  if (!Number.isInteger(bet) || bet < min || bet > max) fail(400, `건 돈은 ${min}~${max}점이에요.`);
  return bet;
}

// ---------- 관리자: 설정(화면에서 바로 조절) ----------
// 저장된 값은 settings 표의 cfg_* 로 남고, 서버가 켜질 때/바꿀 때 아래 변수들에 반영돼요.
const SETTING_SPECS = [
  { key: 'solo_net_cap', label: '혼자 하는 게임 하루 순이익 한도(점)', hint: '블랙잭+슬롯으로 하루에 벌 수 있는 최대 점수 (딴 돈 − 잃은 돈). 0이면 한도 없음', type: 'int', min: 0, max: 1000000, get: () => G.SOLO.DAILY_NET_CAP, set: (v) => { G.SOLO.DAILY_NET_CAP = v; } },
  { key: 'solo_plays', label: '혼자 하는 게임 하루 판 수', hint: '블랙잭 한 판, 슬롯 한 번이 각각 1판. 0이면 무제한', type: 'int', min: 0, max: 10000, get: () => G.SOLO.DAILY_PLAYS, set: (v) => { G.SOLO.DAILY_PLAYS = v; } },
  { key: 'bj_max_bet', label: '블랙잭 한 판 최대 건 돈(점)', hint: `최소 ${G.BJ.MIN_BET}점`, type: 'int', min: G.BJ.MIN_BET, max: 1000000, get: () => G.BJ.MAX_BET, set: (v) => { G.BJ.MAX_BET = v; } },
  { key: 'slot_max_bet', label: '슬롯 한 번 최대 건 돈(점)', hint: `최소 ${G.SLOT.MIN_BET}점`, type: 'int', min: G.SLOT.MIN_BET, max: 1000000, get: () => G.SLOT.MAX_BET, set: (v) => { G.SLOT.MAX_BET = v; } },
  { key: 'room_stake_max', label: '방 게임(눈치게임·사다리) 최대 판돈(점)', hint: `최소 ${MIN_BET}점`, type: 'int', min: MIN_BET, max: 1000000, get: () => ROOM_STAKE_MAX, set: (v) => { ROOM_STAKE_MAX = v; } },
  { key: 'lucky_percent', label: '럭키 보너스 확률(%)', hint: '도박에서 이긴 사람마다 이 확률로 보너스(받은 돈의 50%). 0이면 없음', type: 'int', min: 0, max: 100, get: () => Math.round(LUCKY_CHANCE * 100), set: (v) => { LUCKY_CHANCE = v / 100; } },
  { key: 'shop_open', label: '상점 열기', hint: '꺼져 있으면 상점은 "준비 중"으로 보이고 구매·장착이 막혀요', type: 'bool', get: () => SHOP_OPEN, set: (v) => { SHOP_OPEN = v; } },
];
const SETTING_DEFAULTS = {};
function applySettings() {
  const saved = {};
  for (const r of q("SELECT k, v FROM settings WHERE k LIKE 'cfg\\_%' ESCAPE '\\'")) saved[r.k.slice(4)] = r.v;
  for (const sp of SETTING_SPECS) {
    if (!(sp.key in SETTING_DEFAULTS)) SETTING_DEFAULTS[sp.key] = sp.get();   // 처음 한 번: 코드의 기본값 기억
    if (sp.key in saved) sp.set(sp.type === 'bool' ? saved[sp.key] === '1' : Number(saved[sp.key]));
    else sp.set(SETTING_DEFAULTS[sp.key]);
  }
}
const settingsView = () => SETTING_SPECS.map(({ key, label, hint, type, min, max, get }) => ({ key, label, hint, type, min: min ?? null, max: max ?? null, value: get(), default: SETTING_DEFAULTS[key] }));

// ---------- 관리자: 게임 방 / PIN 방 ----------
function adminRooms() {
  const nameOf = (id) => q1('SELECT name FROM users WHERE id=?', id)?.name || '(탈퇴)';
  const grpOfUser = (id) => (q1('SELECT r.code g FROM users u LEFT JOIN rooms r ON r.grp=u.grp WHERE u.id=?', id)?.g) || null;
  const out = [];
  for (const r of q("SELECT * FROM rps WHERE status='waiting'")) out.push({ kind: 'rps', id: r.id, host: nameOf(r.host_id), stake: r.stake, players: [nameOf(r.host_id)], cap: 2, created_at: r.created_at, grp: grpOfUser(r.host_id) });   // 손은 안 보임
  for (const r of q("SELECT * FROM lun WHERE status='waiting'")) out.push({ kind: 'lun', id: r.id, host: nameOf(r.host_id), stake: r.stake, players: q('SELECT user_id FROM lun_p WHERE room_id=? ORDER BY id', r.id).map((p) => nameOf(p.user_id)), cap: r.cap, created_at: r.created_at, grp: grpOfUser(r.host_id) });   // 숫자는 안 보임
  for (const r of q("SELECT * FROM lad WHERE status='waiting'")) out.push({ kind: 'lad', id: r.id, host: nameOf(r.host_id), stake: r.stake, players: q('SELECT user_id FROM lad_p WHERE room_id=? ORDER BY slot', r.id).map((p) => nameOf(p.user_id)), cap: r.slots, created_at: r.created_at, grp: grpOfUser(r.host_id) });
  return out.sort((a, b) => b.created_at - a.created_at);
}
function adminGroups() {
  const codes = new Map(q('SELECT grp, code FROM rooms').map((r) => [r.grp, r.code]));
  for (const r of q('SELECT DISTINCT grp FROM users')) if (!codes.has(r.grp)) codes.set(r.grp, null);
  return [...codes.keys()].map((grp) => {
    const members = q('SELECT id, name, points FROM users WHERE grp IS ? ORDER BY points DESC', grp);
    const ids = members.map((m) => m.id).join(',') || '0';
    return { id: grp || '', label: codes.get(grp) || '방 없음', members: members.map((m) => m.name), count: members.length, points: members.reduce((a, m) => a + m.points, 0),
      bets: q1(`SELECT COUNT(*) n FROM bets WHERE creator_id IN (${ids})`).n,
      rooms: ['rps', 'lun', 'lad'].reduce((n, t) => n + q1(`SELECT COUNT(*) n FROM ${t} WHERE status='waiting' AND host_id IN (${ids})`).n, 0) };
  }).sort((a, b) => b.count - a.count);
}
function adminCloseRoom(kind, roomId) {
  const t = { rps: 'rps', lun: 'lun', lad: 'lad' }[kind] || fail(400, '알 수 없는 게임이에요.');
  const r = q1(`SELECT * FROM ${t} WHERE id=?`, Number(roomId)) || fail(404, '방이 없어요.');
  if (r.status !== 'waiting') fail(400, '이미 끝났거나 닫힌 방이에요.');
  if (t === 'rps') pay(r.host_id, r.stake);
  else for (const p of q(`SELECT user_id FROM ${t}_p WHERE room_id=?`, r.id)) pay(p.user_id, r.stake);
  run(`UPDATE ${t} SET status='cancelled' WHERE id=?`, r.id);
}
// PIN 방 하나를 통째로 지움: 그 방 사람들과 그 사람들의 도박·채팅·게임 기록이 모두 사라져요
function adminDeleteGroup(grp) {
  const ids = q('SELECT id FROM users WHERE grp IS ?', grp || null).map((r) => r.id);
  if (!ids.length && !q1('SELECT 1 FROM rooms WHERE grp=?', grp || '')) fail(404, '그 방이 없어요.');
  if (!ids.length) { run('DELETE FROM rooms WHERE grp=?', grp); return 0; }
  const L = ids.join(',');
  const betIds = q(`SELECT id FROM bets WHERE creator_id IN (${L})`).map((r) => r.id);
  if (betIds.length) { const B = betIds.join(','); for (const t of ['messages', 'wagers', 'options']) run(`DELETE FROM ${t} WHERE bet_id IN (${B})`); run(`DELETE FROM bets WHERE id IN (${B})`); }
  run(`DELETE FROM wagers WHERE user_id IN (${L})`); run(`DELETE FROM messages WHERE user_id IN (${L})`);
  for (const t of ['lun', 'lad']) {
    const rooms = q(`SELECT id FROM ${t} WHERE host_id IN (${L})`).map((r) => r.id);
    if (rooms.length) run(`DELETE FROM ${t}_p WHERE room_id IN (${rooms.join(',')})`);
    run(`DELETE FROM ${t}_p WHERE user_id IN (${L})`); run(`DELETE FROM ${t} WHERE host_id IN (${L})`);
  }
  run(`DELETE FROM rps WHERE host_id IN (${L}) OR guest_id IN (${L})`);
  for (const t of ['bj', 'slots', 'user_items', 'sessions']) run(`DELETE FROM ${t} WHERE user_id IN (${L})`);
  run(`DELETE FROM users WHERE id IN (${L})`);
  run('DELETE FROM rooms WHERE grp=?', grp || '');
  return ids.length;
}

// ---------- 직렬화 ----------
function betView(b, me) {
  const opts = q('SELECT id,label FROM options WHERE bet_id=? ORDER BY id', b.id);
  const sums = Object.fromEntries(q('SELECT option_id o, SUM(amount) s, COUNT(*) n FROM wagers WHERE bet_id=? GROUP BY option_id', b.id).map((r) => [r.o, r]));
  const total = Object.values(sums).reduce((s, r) => s + r.s, 0);
  const mine = me ? q('SELECT option_id,amount,payout,lucky FROM wagers WHERE bet_id=? AND user_id=?', b.id, me.id) : [];
  const creator = q1('SELECT name FROM users WHERE id=?', b.creator_id)?.name;
  return {
    id: b.id, title: b.title, creator, mine_created: me?.id === b.creator_id, status: b.status,
    winner: b.winner, closes_at: b.closes_at, created_at: b.created_at, total,
    options: opts.map((o) => {
      const pool = sums[o.id]?.s || 0;
      const share = total ? pool / total : 0;
      return {
        id: o.id, label: o.label, pool, bettors: sums[o.id]?.n || 0, share,
        // 지금 이 선택지에 1점 걸어 이기면 받는 배수(참고용)
        multiplier: pool ? Math.round((total / pool) * 100) / 100 : null,
        underdog: total > 0 && share < UNDERDOG_SHARE,
        my_amount: mine.filter((m) => m.option_id === o.id).reduce((s, m) => s + m.amount, 0),
      };
    }),
    my_payout: mine.length && (b.status === 'resolved' || b.status === 'cancelled') ? mine.reduce((s, m) => s + (m.payout || 0), 0) : null,
    my_total: mine.reduce((s, m) => s + m.amount, 0),
    my_lucky: mine.some((m) => m.lucky),
    chat_count: q1('SELECT COUNT(*) n FROM messages WHERE bet_id=?', b.id).n,
  };
}
const me = (u) => u && { id: u.id, name: u.name, points: u.points, can_aid: u.points < MIN_BET && now() - u.last_aid > 864e5, group_size: q1('SELECT COUNT(*) n FROM users WHERE grp IS ?', grpOf(u)).n, room: roomCodeOf(u), ...deco(u) };

// ---------- 인증 ----------
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString('hex');
// PIN이 같은 사람끼리만 같은 '방'. 방 번호(grp)는 PIN에서 만든 값이고, 도박·가위바위보·채팅·랭킹은 같은 방끼리만 보여요.
function pepper() {
  let r = q1("SELECT v FROM settings WHERE k='pepper'");
  if (!r) { run("INSERT INTO settings VALUES ('pepper', ?)", crypto.randomBytes(16).toString('hex')); r = q1("SELECT v FROM settings WHERE k='pepper'"); }
  return r.v;
}
const groupKey = (pin) => crypto.createHash('sha256').update('grp:' + pepper() + pin).digest('hex').slice(0, 16);
const grpOf = (u) => (u && u.grp) || null;
// 방 코드(친구들과 같은 값 → 같은 방)와 PIN(나만 아는 로그인 비밀번호)은 따로예요. 닉네임은 방 안에서만 겹치지 않으면 돼요.
const PIN_RE = /^\S{4,16}$/, ROOM_RE = /^[\p{L}\p{N}]{4,12}$/u;
const roomCodeOf = (u) => (u && u.grp ? q1('SELECT code FROM rooms WHERE grp=?', u.grp)?.code : null) || null;
function ensureRoom(code) {                       // 방이 없으면 만들고 방 번호(grp)를 돌려줌
  if (!ROOM_RE.test(code)) fail(400, '방 코드는 글자/숫자 4~12자예요.');
  const g = groupKey(code);
  if (!q1('SELECT 1 FROM rooms WHERE grp=?', g)) run('INSERT INTO rooms(grp,code,created_at) VALUES (?,?,?)', g, code, now());
  return g;
}
const userInRoom = (grp, name) => q1('SELECT * FROM users WHERE grp=? AND name=?', grp, name);
function addAccount(grp, name, pin) {
  if (!PIN_RE.test(pin)) fail(400, 'PIN은 공백 없이 4~16자예요.');
  const salt = crypto.randomBytes(8).toString('hex');
  const r = run('INSERT INTO users(name,salt,hash,points,created_at,grp) VALUES (?,?,?,?,?,?)', name, salt, hashPin(pin, salt), START_POINTS, now(), grp);
  return newSession(Number(r.lastInsertRowid));
}
// 같은 방의 도박만 볼 수 있음 (도박을 연 사람의 방 기준). 아니면 null.
function visibleBet(betId, u) {
  return q1('SELECT b.* FROM bets b JOIN users c ON c.id=b.creator_id WHERE b.id=? AND c.grp IS ?', Number(betId), grpOf(u));
}
function newSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO sessions VALUES (?,?,?)', token, userId, now());
  return token;
}
function authUser(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return null;
  const s = q1('SELECT user_id FROM sessions WHERE token=?', t);
  return s ? q1('SELECT * FROM users WHERE id=?', s.user_id) : null;
}
const attempts = new Map(); // 로그인 무차별 대입 방지(이름+IP당 5분 10회)
function throttle(key) {
  const a = (attempts.get(key) || []).filter((t) => now() - t < 3e5);
  if (a.length >= 10) fail(429, '로그인 시도가 너무 많아요. 5분 뒤 다시 해주세요.');
  a.push(now()); attempts.set(key, a);
}

function betAction(bet, body) {
  if (bet.status === 'resolved' || bet.status === 'cancelled') fail(400, '이미 끝난 도박이에요.');
  if (body.action === 'close') { run("UPDATE bets SET status='closed' WHERE id=?", bet.id); return { ok: true }; }
  if (body.action === 'cancel') {
    for (const w of q('SELECT * FROM wagers WHERE bet_id=?', bet.id)) refund(w);
    run("UPDATE bets SET status='cancelled' WHERE id=?", bet.id);
    return { ok: true };
  }
  if (body.action === 'resolve') {
    const opt = q1('SELECT * FROM options WHERE id=? AND bet_id=?', Number(body.option_id), bet.id) || fail(400, '정답 선택지를 골라주세요.');
    const r = settle(bet, opt.id);
    run('UPDATE bets SET status=?, winner=? WHERE id=?', r.refunded ? 'cancelled' : 'resolved', r.refunded ? null : opt.id, bet.id);
    return { ok: true, ...r };
  }
  fail(400, '알 수 없는 동작이에요.');
}
const NAME_RE = /^[\p{L}\p{N}_ ]{1,12}$/u;
function checkName(raw) {
  const name = String(raw || '').trim();
  if (!NAME_RE.test(name)) fail(400, '닉네임은 12자 이내 글자/숫자만 가능해요.');
  return name;
}
async function verifyGoogle(credential) {
  if (!GOOGLE_CLIENT_ID) fail(400, '구글 로그인이 아직 설정되지 않았어요.');
  let j;
  try {
    const r = await fetch(`${TOKENINFO_URL}?id_token=${encodeURIComponent(String(credential || ''))}`);
    if (!r.ok) fail(401, '구글 인증에 실패했어요.');
    j = await r.json();
  } catch (e) { if (e instanceof HttpError) throw e; fail(502, '구글 서버에 연결하지 못했어요.'); }
  const okIss = j.iss === 'accounts.google.com' || j.iss === 'https://accounts.google.com';
  if (j.aud !== GOOGLE_CLIENT_ID || !okIss || !j.sub || Number(j.exp) * 1000 < now()) fail(401, '구글 인증에 실패했어요.');
  return String(j.sub);
}
const pendingGoogle = new Map(); // 닉네임 정하기 전 임시 토큰 (10분)
function adminOnly(req) {
  throttle('admin|' + req.socket.remoteAddress);
  const k = String(req.headers['x-admin-key'] || '');
  const a = Buffer.from(k), b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail(403, '관리자 키가 틀렸어요.');
  attempts.delete('admin|' + req.socket.remoteAddress); // 성공하면 카운트 초기화
}

// ---------- API ----------
const routes = {
  // (테스트/내부용) 방 코드를 안 주면 PIN을 방 코드로 씀. 방이 없으면 만들고 계정을 만듦
  'POST /api/signup': (req, body) => {
    const name = checkName(body.name), pin = String(body.pin ?? '');
    if (!PIN_RE.test(pin)) fail(400, 'PIN은 공백 없이 4~16자예요.');   // 방을 만들기 전에 값부터 검사 (실패했는데 빈 방이 남지 않게)
    const grp = ensureRoom(String(body.room ?? pin).trim());
    if (userInRoom(grp, name)) fail(409, '이 방에 이미 있는 닉네임이에요.');
    return { token: addAccount(grp, name, pin) };
  },
  'POST /api/login': (req, body) => {
    const name = String(body.name || '').trim(), pin = String(body.pin ?? ''), code = String(body.room ?? pin).trim();
    throttle(code + '|' + name + '|' + req.socket.remoteAddress);
    const u = userInRoom(groupKey(code), name);
    if (!u || !u.hash || hashPin(pin, u.salt) !== u.hash) fail(401, '방 코드, 닉네임, PIN을 확인해 주세요.');
    attempts.delete(code + '|' + name + '|' + req.socket.remoteAddress);
    return { token: newSession(u.id) };
  },
  // 방 들어가기(mode:'join') / 방 만들기(mode:'create'). 들어갈 땐: 이 방에 닉네임이 있으면 로그인(PIN 확인), 없으면 (확인 후) 새 계정.
  'POST /api/enter': (req, body) => {
    const name = String(body.name || '').trim(), pin = String(body.pin ?? ''), code = String(body.room ?? '').trim();
    if (!ROOM_RE.test(code)) fail(400, '방 코드는 글자/숫자 4~12자예요.');
    const grp = groupKey(code), room = q1('SELECT 1 FROM rooms WHERE grp=?', grp);
    if (body.mode === 'create') {
      if (room) fail(409, '이미 있는 방 코드예요. 그 방에 들어가려면 "방 들어가기"를 눌러주세요.');
      checkName(name);
      if (!PIN_RE.test(pin)) fail(400, 'PIN은 공백 없이 4~16자예요.');   // 방을 만들기 전에 값부터 검사
      ensureRoom(code);
      return { token: addAccount(grp, name, pin), created_room: true };
    }
    if (!room) fail(404, '없는 방 코드예요. 방을 새로 만들려면 "방 만들기"를 눌러주세요.');
    const u = userInRoom(grp, name);
    if (u) {
      throttle(code + '|' + name + '|' + req.socket.remoteAddress);
      if (!u.hash || hashPin(pin, u.salt) !== u.hash) fail(401, '이 방에 이미 있는 닉네임이에요. 내 계정이면 PIN이 달라요(다시 확인해 주세요). 처음이라면 다른 닉네임을 써주세요.');
      attempts.delete(code + '|' + name + '|' + req.socket.remoteAddress);
      return { token: newSession(u.id) };
    }
    checkName(name);
    if (!PIN_RE.test(pin)) fail(400, 'PIN은 공백 없이 4~16자예요.');
    if (!body.create) return { new_user: true };
    return { token: addAccount(grp, name, pin) };
  },
  'GET /api/config': () => ({ google_client_id: GOOGLE_CLIENT_ID || null }),
  'POST /api/google': async (req, body) => {
    throttle('google|' + req.socket.remoteAddress);
    const sub = await verifyGoogle(body.credential);
    const u = q1('SELECT id FROM users WHERE google_sub=?', sub);
    if (u) return { token: newSession(u.id) };
    const pending = crypto.randomBytes(16).toString('hex');
    pendingGoogle.set(pending, { sub, exp: now() + 6e5 });
    return { needs_nickname: true, pending };
  },
  'POST /api/google/signup': (req, body) => {
    const p = pendingGoogle.get(String(body.pending || ''));
    if (!p || p.exp < now()) fail(400, '시간이 지났어요. 구글 로그인을 다시 해주세요.');
    const name = checkName(body.name);
    if (q1('SELECT 1 FROM users WHERE name=? AND grp IS NULL', name)) fail(409, '이미 있는 닉네임이에요.');
    const r = run('INSERT INTO users(name,salt,hash,points,created_at,google_sub) VALUES (?,?,?,?,?,?)', name, '', '', START_POINTS, now(), p.sub);
    pendingGoogle.delete(String(body.pending));
    return { token: newSession(Number(r.lastInsertRowid)) };
  },
  'POST /api/nickname': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    const name = checkName(body.name);
    const other = q1('SELECT id FROM users WHERE name=? AND grp IS ?', name, grpOf(u));
    if (other && other.id !== u.id) fail(409, '이미 있는 닉네임이에요.');
    run('UPDATE users SET name=? WHERE id=?', name, u.id);
    return { ok: true };
  },
  // 채팅은 도박마다 따로: 목록에서 도박에 들어가서 그 안에서만 이야기해요
  'GET /api/chat': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    const sp = new URL(req.url, 'http://x').searchParams;
    const betId = Number(sp.get('bet')) || 0, after = Number(sp.get('after')) || 0;
    if (!visibleBet(betId, u)) fail(404, '도박이 없어요.');
    const cols = 'm.id, m.text, m.created_at, m.user_id, u.name, u.eq_title, u.eq_color, u.eq_fx, u.eq_badge';
    const rows = after
      ? q(`SELECT ${cols} FROM messages m JOIN users u ON u.id=m.user_id WHERE m.bet_id=? AND m.id>? ORDER BY m.id LIMIT 100`, betId, after)
      : q(`SELECT * FROM (SELECT ${cols} FROM messages m JOIN users u ON u.id=m.user_id WHERE m.bet_id=? ORDER BY m.id DESC LIMIT 60) ORDER BY id`, betId);
    return rows.map((r) => ({ id: r.id, text: r.text, name: r.name, at: r.created_at, mine: r.user_id === u.id, ...deco(r) }));
  },
  'POST /api/chat': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    const betId = Number(body.bet_id) || 0;
    if (!visibleBet(betId, u)) fail(404, '도박이 없어요.');
    const text = String(body.text || '').trim();
    if (!text || text.length > 200) fail(400, '메시지는 1~200자예요.');
    const last = q1('SELECT created_at FROM messages WHERE user_id=? ORDER BY id DESC LIMIT 1', u.id);
    if (last && now() - last.created_at < 800) fail(429, '너무 빨라요! 잠깐만요.');
    run('INSERT INTO messages(user_id,bet_id,text,created_at) VALUES (?,?,?,?)', u.id, betId, text, now());
    run('DELETE FROM messages WHERE id < (SELECT MAX(id) FROM messages) - 2000');
    return { ok: true };
  },
  'GET /api/rps': (req, body, u) => { if (!u) fail(401, '로그인이 필요해요.'); return rpsView(u); },
  'POST /api/rps/create': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    const hand = String(body.hand), stake = Number(body.stake);
    if (!RPS_HANDS.includes(hand)) fail(400, '가위·바위·보 중에 골라주세요.');
    if (!Number.isInteger(stake) || stake < MIN_BET) fail(400, `판돈은 ${MIN_BET}점 이상이에요.`);
    return tx(() => {
      const f = q1('SELECT points FROM users WHERE id=?', u.id);
      if (f.points < stake) fail(400, '포인트가 부족해요.');
      if (isDup("SELECT 1 FROM rps WHERE host_id=? AND stake=? AND status='waiting'", u.id, stake)) fail(409, '연타');
      if (q1("SELECT COUNT(*) n FROM rps WHERE host_id=? AND status='waiting'", u.id).n >= RPS_MAX_OPEN) fail(400, `동시에 열 수 있는 방은 ${RPS_MAX_OPEN}개까지예요.`);
      run('UPDATE users SET points=points-? WHERE id=?', stake, u.id);   // 판돈은 방을 여는 순간 맡겨짐
      const id = Number(run('INSERT INTO rps(host_id,stake,host_hand,created_at) VALUES (?,?,?,?)', u.id, stake, hand, now()).lastInsertRowid);
      return { ok: true, id };
    });
  },
  'POST /api/rps/join': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    const hand = String(body.hand);
    if (!RPS_HANDS.includes(hand)) fail(400, '가위·바위·보 중에 골라주세요.');
    return tx(() => {
      const r = q1('SELECT * FROM rps WHERE id=?', Number(body.room_id)) || fail(404, '방이 없어요.');
      const host = q1('SELECT grp FROM users WHERE id=?', r.host_id);
      if (!host || (host.grp || null) !== grpOf(u)) fail(404, '방이 없어요.');   // 다른 PIN 방의 가위바위보에는 못 들어옴
      if (r.status !== 'waiting') fail(400, '이미 끝났거나 닫힌 방이에요.');
      if (r.host_id === u.id) fail(400, '내가 만든 방에는 들어갈 수 없어요.');
      const f = q1('SELECT points FROM users WHERE id=?', u.id);
      if (f.points < r.stake) fail(400, '포인트가 부족해요.');
      const result = r.host_hand === hand ? 'draw' : RPS_BEATS[r.host_hand] === hand ? 'host' : 'guest';
      // 방장은 판돈을 이미 냈고, 도전자는 지금 낸다. 이긴 쪽이 2배, 비기면 각자 환불.
      if (result === 'draw') { run('UPDATE users SET points=points+? WHERE id=?', r.stake, r.host_id); }
      else if (result === 'host') { run('UPDATE users SET points=points+? WHERE id=?', r.stake * 2, r.host_id); run('UPDATE users SET points=points-? WHERE id=?', r.stake, u.id); }
      else { run('UPDATE users SET points=points+? WHERE id=?', r.stake, u.id); }
      run("UPDATE rps SET guest_id=?, guest_hand=?, status='done', result=?, played_at=? WHERE id=?", u.id, hand, result, now(), r.id);
      return { ok: true, id: r.id, host_hand: r.host_hand, guest_hand: hand, stake: r.stake, host: rpsPlayer(r.host_id),
        outcome: result === 'draw' ? 'draw' : result === 'guest' ? 'win' : 'lose', net: result === 'draw' ? 0 : result === 'guest' ? r.stake : -r.stake };
    });
  },
  'POST /api/rps/cancel': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    return tx(() => {
      const r = q1('SELECT * FROM rps WHERE id=?', Number(body.room_id)) || fail(404, '방이 없어요.');
      if (r.host_id !== u.id) fail(403, '방을 만든 사람만 닫을 수 있어요.');
      if (r.status !== 'waiting') fail(400, '이미 끝났거나 닫힌 방이에요.');
      run('UPDATE users SET points=points+? WHERE id=?', r.stake, u.id);
      run("UPDATE rps SET status='cancelled' WHERE id=?", r.id);
      return { ok: true };
    });
  },
  /* ---- 🤫 최저 유일 숫자 ---- */
  'GET /api/lun': (req, body, u) => { if (!u) fail(401, '로그인이 필요해요.'); return lunView(u); },
  'POST /api/lun/create': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    const stake = checkStake(body.stake), cap = Number(body.cap), num = Number(body.num);
    if (!Number.isInteger(cap) || cap < G.LUN.MIN_PLAYERS || cap > G.LUN.MAX_PLAYERS) fail(400, `인원은 ${G.LUN.MIN_PLAYERS}~${G.LUN.MAX_PLAYERS}명이에요.`);
    if (!Number.isInteger(num) || num < G.LUN.MIN || num > G.LUN.MAX) fail(400, `숫자는 ${G.LUN.MIN}~${G.LUN.MAX} 중에 골라주세요.`);
    return tx(() => {
      if (q1('SELECT points FROM users WHERE id=?', u.id).points < stake) fail(400, '포인트가 부족해요.');
      if (isDup("SELECT 1 FROM lun WHERE host_id=? AND stake=? AND cap=? AND status='waiting'", u.id, stake, cap)) fail(409, '연타');
      if (openRooms('lun', u.id) >= RPS_MAX_OPEN) fail(400, `동시에 열 수 있는 방은 ${RPS_MAX_OPEN}개까지예요.`);
      pay(u.id, -stake);
      const id = Number(run('INSERT INTO lun(host_id,stake,cap,created_at) VALUES (?,?,?,?)', u.id, stake, cap, now()).lastInsertRowid);
      run('INSERT INTO lun_p(room_id,user_id,num,joined_at) VALUES (?,?,?,?)', id, u.id, num, now());
      return { ok: true, id };
    });
  },
  'POST /api/lun/join': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    const num = Number(body.num);
    if (!Number.isInteger(num) || num < G.LUN.MIN || num > G.LUN.MAX) fail(400, `숫자는 ${G.LUN.MIN}~${G.LUN.MAX} 중에 골라주세요.`);
    return tx(() => {
      const r = q1('SELECT * FROM lun WHERE id=?', Number(body.room_id)) || fail(404, '방이 없어요.');
      if (!sameRoomHost(r.host_id, u)) fail(404, '방이 없어요.');
      if (r.status !== 'waiting') fail(400, '이미 끝났거나 닫힌 방이에요.');
      if (q1('SELECT 1 FROM lun_p WHERE room_id=? AND user_id=?', r.id, u.id)) fail(400, '이미 들어간 방이에요.');
      if (q1('SELECT COUNT(*) n FROM lun_p WHERE room_id=?', r.id).n >= r.cap) fail(400, '자리가 다 찼어요.');
      if (q1('SELECT points FROM users WHERE id=?', u.id).points < r.stake) fail(400, '포인트가 부족해요.');
      pay(u.id, -r.stake);
      run('INSERT INTO lun_p(room_id,user_id,num,joined_at) VALUES (?,?,?,?)', r.id, u.id, num, now());
      const full = q1('SELECT COUNT(*) n FROM lun_p WHERE room_id=?', r.id).n >= r.cap;
      if (full) lunResolve(r);
      return { ok: true, id: r.id, resolved: full };
    });
  },
  'POST /api/lun/start': (req, body, u) => {   // 방장이 모인 사람들(3명 이상)로 먼저 시작
    if (!u) fail(401, '로그인이 필요해요.');
    return tx(() => {
      const r = q1('SELECT * FROM lun WHERE id=?', Number(body.room_id)) || fail(404, '방이 없어요.');
      if (r.host_id !== u.id) fail(403, '방을 만든 사람만 시작할 수 있어요.');
      if (r.status !== 'waiting') fail(400, '이미 끝났거나 닫힌 방이에요.');
      if (q1('SELECT COUNT(*) n FROM lun_p WHERE room_id=?', r.id).n < G.LUN.MIN_PLAYERS) fail(400, `최소 ${G.LUN.MIN_PLAYERS}명이 모여야 시작할 수 있어요.`);
      lunResolve(r);
      return { ok: true, id: r.id, resolved: true };
    });
  },
  'POST /api/lun/cancel': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    return tx(() => {
      const r = q1('SELECT * FROM lun WHERE id=?', Number(body.room_id)) || fail(404, '방이 없어요.');
      if (r.host_id !== u.id) fail(403, '방을 만든 사람만 닫을 수 있어요.');
      if (r.status !== 'waiting') fail(400, '이미 끝났거나 닫힌 방이에요.');
      for (const p of q('SELECT user_id FROM lun_p WHERE room_id=?', r.id)) pay(p.user_id, r.stake);
      run("UPDATE lun SET status='cancelled' WHERE id=?", r.id);
      return { ok: true };
    });
  },

  /* ---- 🪜 사다리타기 ---- */
  'GET /api/ladder': (req, body, u) => { if (!u) fail(401, '로그인이 필요해요.'); return ladderView(u); },
  'POST /api/ladder/create': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    const stake = checkStake(body.stake), slots = Number(body.slots), slot = Number(body.slot);
    if (!Number.isInteger(slots) || slots < G.LADDER.MIN_SLOTS || slots > G.LADDER.MAX_SLOTS) fail(400, `인원은 ${G.LADDER.MIN_SLOTS}~${G.LADDER.MAX_SLOTS}명이에요.`);
    if (!Number.isInteger(slot) || slot < 0 || slot >= slots) fail(400, '자리를 골라주세요.');
    return tx(() => {
      if (q1('SELECT points FROM users WHERE id=?', u.id).points < stake) fail(400, '포인트가 부족해요.');
      if (isDup("SELECT 1 FROM lad WHERE host_id=? AND stake=? AND slots=? AND status='waiting'", u.id, stake, slots)) fail(409, '연타');
      if (openRooms('lad', u.id) >= RPS_MAX_OPEN) fail(400, `동시에 열 수 있는 방은 ${RPS_MAX_OPEN}개까지예요.`);
      pay(u.id, -stake);
      const id = Number(run('INSERT INTO lad(host_id,stake,slots,created_at) VALUES (?,?,?,?)', u.id, stake, slots, now()).lastInsertRowid);
      run('INSERT INTO lad_p(room_id,user_id,slot,joined_at) VALUES (?,?,?,?)', id, u.id, slot, now());
      return { ok: true, id };
    });
  },
  'POST /api/ladder/join': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    const slot = Number(body.slot);
    return tx(() => {
      const r = q1('SELECT * FROM lad WHERE id=?', Number(body.room_id)) || fail(404, '방이 없어요.');
      if (!sameRoomHost(r.host_id, u)) fail(404, '방이 없어요.');
      if (r.status !== 'waiting') fail(400, '이미 끝났거나 닫힌 방이에요.');
      if (!Number.isInteger(slot) || slot < 0 || slot >= r.slots) fail(400, '자리를 골라주세요.');
      if (q1('SELECT 1 FROM lad_p WHERE room_id=? AND user_id=?', r.id, u.id)) fail(400, '이미 들어간 방이에요.');
      if (q1('SELECT 1 FROM lad_p WHERE room_id=? AND slot=?', r.id, slot)) fail(400, '이미 다른 사람이 앉은 자리예요.');
      if (q1('SELECT points FROM users WHERE id=?', u.id).points < r.stake) fail(400, '포인트가 부족해요.');
      pay(u.id, -r.stake);
      run('INSERT INTO lad_p(room_id,user_id,slot,joined_at) VALUES (?,?,?,?)', r.id, u.id, slot, now());
      const full = q1('SELECT COUNT(*) n FROM lad_p WHERE room_id=?', r.id).n >= r.slots;
      if (full) ladderResolve(r);          // 자리가 다 차는 순간 사다리를 만들어서 결판 (그 전엔 사다리가 존재하지 않음)
      return { ok: true, id: r.id, resolved: full };
    });
  },
  'POST /api/ladder/cancel': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    return tx(() => {
      const r = q1('SELECT * FROM lad WHERE id=?', Number(body.room_id)) || fail(404, '방이 없어요.');
      if (r.host_id !== u.id) fail(403, '방을 만든 사람만 닫을 수 있어요.');
      if (r.status !== 'waiting') fail(400, '이미 끝났거나 닫힌 방이에요.');
      for (const p of q('SELECT user_id FROM lad_p WHERE room_id=?', r.id)) pay(p.user_id, r.stake);
      run("UPDATE lad SET status='cancelled' WHERE id=?", r.id);
      return { ok: true };
    });
  },

  /* ---- 🃏 블랙잭 ---- */
  'GET /api/blackjack': (req, body, u) => { if (!u) fail(401, '로그인이 필요해요.'); return bjView(u); },
  'POST /api/blackjack/start': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    const bet = checkBet(body.bet, G.BJ.MIN_BET, G.BJ.MAX_BET);
    return tx(() => {
      if (bjActive(u.id)) fail(400, '진행 중인 판이 있어요. 먼저 끝내주세요.');
      soloGuard(u.id);
      if (q1('SELECT points FROM users WHERE id=?', u.id).points < bet) fail(400, '포인트가 부족해요.');
      pay(u.id, -bet);
      const st = G.bjStart(bet);
      const id = Number(run("INSERT INTO bj(user_id,bet,state,status,created_at) VALUES (?,?,?,'playing',?)", u.id, bet, JSON.stringify(st), now()).lastInsertRowid);
      bjSave({ id, user_id: u.id }, st);
      return bjView(u);
    });
  },
  ...Object.fromEntries(['hit', 'stand', 'double'].map((act) => ['POST /api/blackjack/' + act, (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    return tx(() => {
      const row = bjActive(u.id) || fail(400, '진행 중인 판이 없어요. 새로 시작해주세요.');
      const st = JSON.parse(row.state);
      if (act === 'double') {
        if (!G.bjCanDouble(st)) fail(400, '더블다운은 처음 카드 두 장일 때만 할 수 있어요.');
        if (q1('SELECT points FROM users WHERE id=?', u.id).points < st.bet) fail(400, '더블다운할 포인트가 부족해요.');
        pay(u.id, -st.bet);                                  // 추가로 같은 금액을 더 걸어요
        G.bjDouble(st);
      } else if (act === 'hit') G.bjHit(st); else G.bjStand(st);
      bjSave(row, st);
      return bjView(u);
    });
  }])),

  /* ---- 🎰 슬롯머신 ---- */
  'GET /api/slots': (req, body, u) => { if (!u) fail(401, '로그인이 필요해요.'); return slotView(u); },
  'POST /api/slots/spin': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    const bet = checkBet(body.bet, G.SLOT.MIN_BET, G.SLOT.MAX_BET);
    return tx(() => {
      if (q1('SELECT points FROM users WHERE id=?', u.id).points < bet) fail(400, '포인트가 부족해요.');
      soloGuard(u.id);
      const sp = G.slotSpin();
      let payout = G.slotPayout(bet, sp.mult), capped = false;
      if (payout - bet > 0) { const allowed = G.soloClampWin(payout - bet, soloToday(u.id).net); if (allowed < payout - bet) { payout = bet + allowed; capped = true; } }   // 오늘 한도까지만 지급
      pay(u.id, payout - bet);
      run('INSERT INTO slots(user_id,bet,reels,payout,created_at) VALUES (?,?,?,?,?)', u.id, bet, JSON.stringify(sp.reels), payout, now());
      return { reels: sp.reels.map((i) => G.SLOT.SYMBOLS[i]), mult: sp.mult, bet, payout, net: payout - bet, capped, points: q1('SELECT points FROM users WHERE id=?', u.id).points, limits: soloLimits(u.id) };
    });
  },

  'GET /api/shop': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    if (!SHOP_OPEN) return [];   // 닫혀 있으면 빈 목록 → 화면에 '준비 중' 표시
    const owned = new Set(q('SELECT item_id FROM user_items WHERE user_id=?', u.id).map((r) => r.item_id));
    return SHOP.map((i) => ({ ...i, owned: owned.has(i.id), equipped: u[SLOT_COL[i.slot]] === i.id }));
  },
  'POST /api/shop/buy': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    if (!SHOP_OPEN) fail(403, '상점은 아직 준비 중이에요.');
    return tx(() => {
      const item = SHOP_BY_ID[String(body.item_id)] || fail(404, '없는 상품이에요.');
      if (q1('SELECT 1 FROM user_items WHERE user_id=? AND item_id=?', u.id, item.id)) fail(400, '이미 가지고 있어요.');
      const f = q1('SELECT points FROM users WHERE id=?', u.id);
      if (f.points < item.price) fail(400, '포인트가 부족해요.');
      run('UPDATE users SET points=points-? WHERE id=?', item.price, u.id);
      run('INSERT INTO user_items VALUES (?,?)', u.id, item.id);
      run(`UPDATE users SET ${SLOT_COL[item.slot]}=? WHERE id=?`, item.id, u.id); // 사면 바로 장착
      return { ok: true };
    });
  },
  'POST /api/shop/equip': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    if (!SHOP_OPEN) fail(403, '상점은 아직 준비 중이에요.');
    if (body.item_id === null) { // 해제: slot 지정
      const col = SLOT_COL[String(body.slot)] || fail(400, '잘못된 칸이에요.');
      run(`UPDATE users SET ${col}=NULL WHERE id=?`, u.id);
      return { ok: true };
    }
    const item = SHOP_BY_ID[String(body.item_id)] || fail(404, '없는 상품이에요.');
    if (!q1('SELECT 1 FROM user_items WHERE user_id=? AND item_id=?', u.id, item.id)) fail(400, '먼저 구매해야 해요.');
    run(`UPDATE users SET ${SLOT_COL[item.slot]}=? WHERE id=?`, item.id, u.id);
    return { ok: true };
  },
  'GET /api/me': (req, body, u) => me(u || fail(401, '로그인이 필요해요.')),
  'GET /api/bets': (req, body, u) => {
    sweep();
    if (!u) return [];
    return q("SELECT b.* FROM bets b JOIN users c ON c.id=b.creator_id WHERE c.grp IS ? ORDER BY (b.status IN ('open','closed')) DESC, b.id DESC LIMIT 100", grpOf(u)).map((b) => betView(b, u));
  },
  'POST /api/bets': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    const title = String(body.title || '').trim();
    const labels = (Array.isArray(body.options) ? body.options : []).map((s) => String(s).trim()).filter(Boolean);
    if (!title || title.length > 80) fail(400, '제목은 1~80자예요.');
    if (labels.length < 2 || labels.length > 6) fail(400, '선택지는 2~6개예요.');
    if (new Set(labels).size !== labels.length || labels.some((l) => l.length > 40)) fail(400, '선택지는 서로 달라야 하고 40자 이내예요.');
    const mins = Number(body.closes_in_minutes);
    const closes = mins > 0 ? now() + Math.min(mins, 60 * 24 * 30) * 6e4 : null;
    return tx(() => {
      if (isDup('SELECT 1 FROM bets WHERE creator_id=? AND title=?', u.id, title)) fail(409, '연타');
      const id = Number(run('INSERT INTO bets(title,creator_id,closes_at,created_at) VALUES (?,?,?,?)', title, u.id, closes, now()).lastInsertRowid);
      for (const l of labels) run('INSERT INTO options(bet_id,label) VALUES (?,?)', id, l);
      return betView(q1('SELECT * FROM bets WHERE id=?', id), u);
    });
  },
  'POST /api/wager': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount < MIN_BET) fail(400, `최소 ${MIN_BET}점부터 걸 수 있어요.`);
    return tx(() => {
      sweep();
      const opt = q1('SELECT * FROM options WHERE id=?', Number(body.option_id)) || fail(404, '선택지가 없어요.');
      const bet = visibleBet(opt.bet_id, u) || fail(404, '도박이 없어요.');
      if (bet.status !== 'open') fail(400, '이미 마감된 도박이에요.');
      const fresh = q1('SELECT points FROM users WHERE id=?', u.id);
      if (fresh.points < amount) fail(400, '포인트가 부족해요.');
      // 한 도박에서 두 선택지에 동시에 걸어 헷지하는 건 막음
      const other = q1('SELECT 1 FROM wagers WHERE bet_id=? AND user_id=? AND option_id<>?', bet.id, u.id, opt.id);
      if (other) fail(400, '이 도박에는 이미 다른 선택지에 걸었어요.');
      run('UPDATE users SET points=points-? WHERE id=?', amount, u.id);
      run('INSERT INTO wagers(bet_id,option_id,user_id,amount,created_at) VALUES (?,?,?,?,?)', bet.id, opt.id, u.id, amount, now());
      return { ok: true };
    });
  },
  // 개설자만: 마감 / 결과 확정 / 취소(전액 환불)
  'POST /api/bets/action': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    return tx(() => {
      const bet = q1('SELECT * FROM bets WHERE id=?', Number(body.bet_id)) || fail(404, '도박이 없어요.');
      if (bet.creator_id !== u.id) fail(403, '도박을 연 사람만 할 수 있어요.');
      return betAction(bet, body);
    });
  },
  'POST /api/aid': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    return tx(() => {
      const f = q1('SELECT * FROM users WHERE id=?', u.id);
      if (f.points >= MIN_BET) fail(400, '아직 포인트가 남아있어요.');
      if (now() - f.last_aid < 864e5) fail(400, '구제금은 하루 한 번이에요.');
      run('UPDATE users SET points=points+?, last_aid=? WHERE id=?', DAILY_AID, now(), u.id);
      return { ok: true };
    });
  },
  'GET /api/admin/overview': (req) => {
    adminOnly(req); sweep();
    const users = q('SELECT u.id, u.name, u.points, u.created_at, r.code grp FROM users u LEFT JOIN rooms r ON r.grp=u.grp ORDER BY u.points DESC');
    const bets = q('SELECT * FROM bets ORDER BY id DESC LIMIT 200').map((b) => betView(b, null));
    const wagers = q('SELECT COUNT(*) n, COALESCE(SUM(amount),0) s, COALESCE(SUM(lucky),0) l FROM wagers')[0];
    const messages = q('SELECT m.id, m.text, m.created_at, u.name, b.title bet_title FROM messages m JOIN users u ON u.id=m.user_id LEFT JOIN bets b ON b.id=m.bet_id ORDER BY m.id DESC LIMIT 40');
    return { users, bets, messages, settings: settingsView(), rooms: adminRooms(), groups: adminGroups(), stats: { users: users.length, points: users.reduce((x, y) => x + y.points, 0), wagers: wagers.n, wagered: wagers.s, lucky: wagers.l } };
  },
  'POST /api/admin/settings': (req, body) => {
    adminOnly(req);
    const values = body.values && typeof body.values === 'object' ? body.values : {}, reset = Array.isArray(body.reset) ? body.reset : [];
    const byKey = Object.fromEntries(SETTING_SPECS.map((sp) => [sp.key, sp]));
    for (const [k, v] of Object.entries(values)) {
      const sp = byKey[k] || fail(400, '알 수 없는 설정이에요: ' + k);
      if (sp.type === 'bool' ? typeof v !== 'boolean' : !Number.isInteger(v) || v < sp.min || v > sp.max) fail(400, `${sp.label}: ${sp.type === 'bool' ? '켜기/끄기만 가능해요' : `${sp.min}~${sp.max} 사이 정수를 넣어주세요`}.`);
    }
    for (const k of reset) if (!byKey[k]) fail(400, '알 수 없는 설정이에요: ' + k);
    tx(() => {
      for (const [k, v] of Object.entries(values)) run('INSERT OR REPLACE INTO settings(k,v) VALUES (?,?)', 'cfg_' + k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
      for (const k of reset) run('DELETE FROM settings WHERE k=?', 'cfg_' + k);
    });
    applySettings();
    return { ok: true, settings: settingsView() };
  },
  'POST /api/admin/room': (req, body) => { adminOnly(req); tx(() => adminCloseRoom(String(body.kind), body.room_id)); return { ok: true }; },
  'POST /api/admin/group': (req, body) => { adminOnly(req); return { ok: true, deleted_users: tx(() => adminDeleteGroup(body.grp ? String(body.grp) : null)) }; },
  'POST /api/admin/user': (req, body) => {
    adminOnly(req);
    return tx(() => {
      const u = q1('SELECT * FROM users WHERE id=?', Number(body.user_id)) || fail(404, '유저가 없어요.');
      const v = Number(body.value);
      if (body.action === 'set_points' || body.action === 'add_points') {
        if (!Number.isInteger(v)) fail(400, '숫자를 넣어주세요.');
        const next = body.action === 'set_points' ? v : u.points + v;
        if (next < 0) fail(400, '0점 미만으로는 못 해요.');
        run('UPDATE users SET points=? WHERE id=?', next, u.id);
      } else if (body.action === 'rename') {
        const name = checkName(body.value);
        if (q1('SELECT 1 FROM users WHERE name=? AND id<>? AND grp IS ?', name, u.id, u.grp)) fail(409, '이미 있는 닉네임이에요.');
        run('UPDATE users SET name=? WHERE id=?', name, u.id);
      } else if (body.action === 'reset_pin') {      // PIN 초기화 (방은 그대로)
        const pin = String(body.value || '');
        if (!PIN_RE.test(pin)) fail(400, 'PIN은 공백 없이 4~16자예요.');
        const salt = crypto.randomBytes(8).toString('hex');
        run('UPDATE users SET salt=?, hash=? WHERE id=?', salt, hashPin(pin, salt), u.id);
        run('DELETE FROM sessions WHERE user_id=?', u.id);
      } else if (body.action === 'move_room') {      // 방 변경: 방 코드로 옮김 (없는 코드면 방을 새로 만듦). 같은 방에 같은 닉네임이 있으면 거부
        const g = ensureRoom(String(body.value || '').trim());
        if (q1('SELECT 1 FROM users WHERE grp=? AND name=? AND id<>?', g, u.name, u.id)) fail(409, '그 방에 같은 닉네임이 이미 있어요.');
        run('UPDATE users SET grp=? WHERE id=?', g, u.id);
      } else if (body.action === 'delete') {
        if (q1("SELECT 1 FROM wagers w JOIN bets b ON b.id=w.bet_id WHERE w.user_id=? AND b.status IN ('open','closed')", u.id)) fail(400, '진행 중인 도박에 건 돈이 있어서 못 지워요. 그 도박을 먼저 정리해주세요.');
        if (q1("SELECT 1 FROM lun_p p JOIN lun r ON r.id=p.room_id WHERE p.user_id=? AND r.status='waiting'", u.id) || q1("SELECT 1 FROM lad_p p JOIN lad r ON r.id=p.room_id WHERE p.user_id=? AND r.status='waiting'", u.id) || q1("SELECT 1 FROM bj WHERE user_id=? AND status='playing'", u.id)) fail(400, '진행 중인 게임이 있어서 못 지워요. 끝나거나 닫힌 뒤에 지워주세요.');
        run("UPDATE rps SET status='cancelled' WHERE host_id=? AND status='waiting'", u.id);
        run('DELETE FROM sessions WHERE user_id=?', u.id);
        run('DELETE FROM messages WHERE user_id=?', u.id);
        run('DELETE FROM user_items WHERE user_id=?', u.id);
        run('DELETE FROM users WHERE id=?', u.id);
      } else fail(400, '알 수 없는 동작이에요.');
      return { ok: true };
    });
  },
  'POST /api/admin/bet': (req, body) => {
    adminOnly(req);
    return tx(() => {
      const bet = q1('SELECT * FROM bets WHERE id=?', Number(body.bet_id)) || fail(404, '도박이 없어요.');
      if (body.action === 'delete') {
        if (bet.status === 'open' || bet.status === 'closed') for (const w of q('SELECT * FROM wagers WHERE bet_id=?', bet.id)) refund(w);
        run('DELETE FROM wagers WHERE bet_id=?', bet.id); run('DELETE FROM messages WHERE bet_id=?', bet.id); run('DELETE FROM options WHERE bet_id=?', bet.id); run('DELETE FROM bets WHERE id=?', bet.id);
        return { ok: true };
      }
      return betAction(bet, body);
    });
  },
  'POST /api/admin/chat': (req, body) => {
    adminOnly(req);
    run('DELETE FROM messages WHERE id=?', Number(body.id));
    return { ok: true };
  },
  'POST /api/admin/gift': (req, body) => {
    adminOnly(req);
    const v = Number(body.amount);
    if (!Number.isInteger(v) || v <= 0 || v > 1e6) fail(400, '1~1000000 사이 정수를 넣어주세요.');
    run('UPDATE users SET points=points+?', v);
    return { ok: true };
  },
  'GET /api/ranking': (req, body, u) => !u ? [] : q(`
    SELECT u.name, u.points, u.eq_title, u.eq_color, u.eq_fx, u.eq_badge,
      (SELECT COUNT(*) FROM wagers w JOIN bets b ON b.id=w.bet_id WHERE w.user_id=u.id AND b.status='resolved' AND w.payout>0) wins,
      (SELECT COUNT(*) FROM wagers w JOIN bets b ON b.id=w.bet_id WHERE w.user_id=u.id AND b.status='resolved' AND w.payout=0) losses
    FROM users u WHERE u.grp IS ? ORDER BY u.points DESC LIMIT 50`, grpOf(u)).map(({ eq_title, eq_color, eq_fx, eq_badge, ...r }) => ({ ...r, ...deco({ eq_title, eq_color, eq_fx, eq_badge }) })),
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const handler = routes[`${req.method} ${url.pathname}`];
  if (url.pathname.startsWith('/api/')) {
    if (!handler) return send(404, { error: '없는 주소예요.' });
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        send(200, await handler(req, body, authUser(req)));
      } catch (e) {
        if (e instanceof HttpError) send(e.code, { error: e.message });
        else if (e instanceof SyntaxError) send(400, { error: '잘못된 요청이에요.' });
        else { console.error(e); send(500, { error: '서버 오류' }); }
      }
    });
    return;
  }
  const page = url.pathname === '/' ? 'index.html' : url.pathname === '/admin' ? 'admin.html' : url.pathname;
  const file = path.join(__dirname, 'public', page);
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

applySettings();   // 저장된 관리자 설정을 반영
if (require.main === module) server.listen(PORT, () => {
  console.log(`사이트:  http://localhost:${PORT}`);
  console.log(`관리자:  http://localhost:${PORT}/admin#${ADMIN_KEY}   (이 링크는 나만 알고 있기!)`);
});
module.exports = { server, db, ADMIN_KEY, applySettings, UNDERDOG_BONUS, UNDERDOG_SHARE };
