// 친구들끼리 쓰는 포인트 내기 사이트. 외부 패키지 없음 (Node 22+).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.db');

const START_POINTS = 1000;
const MIN_BET = 10;
const DAILY_AID = 100;          // 파산 구제금(포인트가 MIN_BET 미만일 때, 하루 1회)
const UNDERDOG_SHARE = 0.30;    // 이긴 쪽 판돈 비중이 이 값 미만이면 역배
const UNDERDOG_BONUS = 0.20;    // 역배 적중 시 총 판돈의 20%를 보너스로 추가 지급

const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
  points INTEGER NOT NULL, last_aid INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, creator_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',  -- open | closed | resolved | cancelled
  winner INTEGER, closes_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS options (id INTEGER PRIMARY KEY, bet_id INTEGER NOT NULL, label TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wagers (
  id INTEGER PRIMARY KEY, bet_id INTEGER NOT NULL, option_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL, payout INTEGER, created_at INTEGER NOT NULL);
`);

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
    // 아무도 못 맞혔거나 전원이 같은 쪽: 내기 성립 안 됨 → 환불
    for (const w of wagers) refund(w);
    return { refunded: true, total, underdog: false };
  }
  const underdog = winPool / total < UNDERDOG_SHARE;
  const pot = total + (underdog ? Math.floor(total * UNDERDOG_BONUS) : 0);
  let paid = 0;
  winners.forEach((w, i) => {
    const pay = i === winners.length - 1 && !underdog ? total - paid : Math.floor((pot * w.amount) / winPool);
    paid += pay;
    run('UPDATE wagers SET payout=? WHERE id=?', pay, w.id);
    run('UPDATE users SET points=points+? WHERE id=?', pay, w.user_id);
  });
  for (const w of wagers) if (w.option_id !== winnerOptionId) run('UPDATE wagers SET payout=0 WHERE id=?', w.id);
  return { refunded: false, total, underdog };
}
function refund(w) {
  run('UPDATE wagers SET payout=? WHERE id=?', w.amount, w.id);
  run('UPDATE users SET points=points+? WHERE id=?', w.amount, w.user_id);
}

// 마감 시간이 지난 open 내기는 closed 로 전환
function sweep() { run("UPDATE bets SET status='closed' WHERE status='open' AND closes_at IS NOT NULL AND closes_at<=?", now()); }

// ---------- 직렬화 ----------
function betView(b, me) {
  const opts = q('SELECT id,label FROM options WHERE bet_id=? ORDER BY id', b.id);
  const sums = Object.fromEntries(q('SELECT option_id o, SUM(amount) s, COUNT(*) n FROM wagers WHERE bet_id=? GROUP BY option_id', b.id).map((r) => [r.o, r]));
  const total = Object.values(sums).reduce((s, r) => s + r.s, 0);
  const mine = me ? q('SELECT option_id,amount,payout FROM wagers WHERE bet_id=? AND user_id=?', b.id, me.id) : [];
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
  };
}
const me = (u) => u && { id: u.id, name: u.name, points: u.points, can_aid: u.points < MIN_BET && now() - u.last_aid > 864e5 };

// ---------- 인증 ----------
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString('hex');
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

// ---------- API ----------
const routes = {
  'POST /api/signup': (req, body) => {
    const name = String(body.name || '').trim(), pin = String(body.pin || '');
    if (!/^[\p{L}\p{N}_ ]{1,12}$/u.test(name)) fail(400, '닉네임은 12자 이내 글자/숫자만 가능해요.');
    if (!/^\d{4}$/.test(pin)) fail(400, 'PIN은 숫자 4자리예요.');
    if (q1('SELECT 1 FROM users WHERE name=?', name)) fail(409, '이미 있는 닉네임이에요.');
    const salt = crypto.randomBytes(8).toString('hex');
    const r = run('INSERT INTO users(name,salt,hash,points,created_at) VALUES (?,?,?,?,?)', name, salt, hashPin(pin, salt), START_POINTS, now());
    return { token: newSession(Number(r.lastInsertRowid)) };
  },
  'POST /api/login': (req, body) => {
    const name = String(body.name || '').trim(), pin = String(body.pin || '');
    throttle(name + '|' + req.socket.remoteAddress);
    const u = q1('SELECT * FROM users WHERE name=?', name);
    if (!u || hashPin(pin, u.salt) !== u.hash) fail(401, '닉네임 또는 PIN이 틀렸어요.');
    return { token: newSession(u.id) };
  },
  'GET /api/me': (req, body, u) => me(u || fail(401, '로그인이 필요해요.')),
  'GET /api/bets': (req, body, u) => {
    sweep();
    return q('SELECT * FROM bets ORDER BY (status IN (\'open\',\'closed\')) DESC, id DESC LIMIT 100').map((b) => betView(b, u));
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
      const bet = q1('SELECT * FROM bets WHERE id=?', opt.bet_id);
      if (bet.status !== 'open') fail(400, '이미 마감된 내기예요.');
      const fresh = q1('SELECT points FROM users WHERE id=?', u.id);
      if (fresh.points < amount) fail(400, '포인트가 부족해요.');
      // 한 내기에서 두 선택지에 동시에 걸어 헷지하는 건 막음
      const other = q1('SELECT 1 FROM wagers WHERE bet_id=? AND user_id=? AND option_id<>?', bet.id, u.id, opt.id);
      if (other) fail(400, '이 내기에는 이미 다른 선택지에 걸었어요.');
      run('UPDATE users SET points=points-? WHERE id=?', amount, u.id);
      run('INSERT INTO wagers(bet_id,option_id,user_id,amount,created_at) VALUES (?,?,?,?,?)', bet.id, opt.id, u.id, amount, now());
      return { ok: true };
    });
  },
  // 개설자만: 마감 / 결과 확정 / 취소(전액 환불)
  'POST /api/bets/action': (req, body, u) => {
    if (!u) fail(401, '로그인이 필요해요.');
    return tx(() => {
      const bet = q1('SELECT * FROM bets WHERE id=?', Number(body.bet_id)) || fail(404, '내기가 없어요.');
      if (bet.creator_id !== u.id) fail(403, '내기를 연 사람만 할 수 있어요.');
      if (bet.status === 'resolved' || bet.status === 'cancelled') fail(400, '이미 끝난 내기예요.');
      if (body.action === 'close') { run("UPDATE bets SET status='closed' WHERE id=?", bet.id); return { ok: true }; }
      if (body.action === 'cancel') {
        for (const w of q('SELECT * FROM wagers WHERE bet_id=?', bet.id)) refund(w);
        run("UPDATE bets SET status='cancelled' WHERE id=?", bet.id);
        return { ok: true };
      }
      if (body.action === 'resolve') {
        const opt = q1('SELECT * FROM options WHERE id=? AND bet_id=?', Number(body.option_id), bet.id) || fail(400, '정답 선택지를 골라주세요.');
        const r = settle(bet, opt.id);
        run("UPDATE bets SET status=?, winner=? WHERE id=?", r.refunded ? 'cancelled' : 'resolved', r.refunded ? null : opt.id, bet.id);
        return { ok: true, ...r };
      }
      fail(400, '알 수 없는 동작이에요.');
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
  'GET /api/ranking': () => q(`
    SELECT u.name, u.points,
      (SELECT COUNT(*) FROM wagers w JOIN bets b ON b.id=w.bet_id WHERE w.user_id=u.id AND b.status='resolved' AND w.payout>0) wins,
      (SELECT COUNT(*) FROM wagers w JOIN bets b ON b.id=w.bet_id WHERE w.user_id=u.id AND b.status='resolved' AND w.payout=0) losses
    FROM users u ORDER BY u.points DESC LIMIT 50`),
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
    req.on('end', () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        send(200, handler(req, body, authUser(req)));
      } catch (e) {
        if (e instanceof HttpError) send(e.code, { error: e.message });
        else if (e instanceof SyntaxError) send(400, { error: '잘못된 요청이에요.' });
        else { console.error(e); send(500, { error: '서버 오류' }); }
      }
    });
    return;
  }
  const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

if (require.main === module) server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
module.exports = { server, UNDERDOG_BONUS, UNDERDOG_SHARE };
