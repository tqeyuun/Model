// Code.gs + Games.gs: 새 게임 4종 (최저 유일 숫자, 사다리타기, 블랙잭, 슬롯머신)
const vm = require('node:vm');
const assert = require('node:assert');
const { makeSandbox } = require('./gas-mock');
const { sb } = makeSandbox();
const G = sb.GAMES;
const call = (token, method, url, body) => { vm.runInContext('TBL = {}; HOLDING = false;', sb); return JSON.parse(sb.handle(token, '', method, url, body)); };
const ok = (r) => { assert.ok(!r.error, JSON.stringify(r)); return r.data; };
const err = (r, code) => { assert.equal(r.code, code, JSON.stringify(r)); return r; };
const mk = (name, pin = '1111') => ok(call('', 'POST', '/api/signup', { name, pin })).token;
const pts = (t) => ok(call(t, 'GET', '/api/state')).me.points;
const rankIdx = { A: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9, J: 10, Q: 11, K: 12 };
const rig = (order) => { const seen = {}; const codes = order.map((r) => { const k = (seen[r] = seen[r] || 0); seen[r]++; return rankIdx[r] + 13 * k; });
  return [...codes, ...Array.from({ length: 52 }, (_, i) => i).filter((c) => !codes.includes(c))]; };
sb.CFG.LUCKY_CHANCE = 0;
G.SOLO.DAILY_NET_CAP = 0; G.SOLO.DAILY_PLAYS = 0;   // 기존 게임 검증은 하루 제한 없이 (제한은 맨 아래에서 따로 검증)

const [a, b, c, d] = ['에이', '비이', '씨이', '디이'].map((n) => mk(n));
const x = mk('엑스', '9999');
const total = () => [a, b, c, d, x].map(pts).reduce((p, q) => p + q);
assert.equal(total(), 5000);

/* ===== 🤫 최저 유일 숫자 ===== */
err(call(a, 'POST', '/api/lun/create', { stake: 100, cap: 2, num: 3 }), 400);
err(call(a, 'POST', '/api/lun/create', { stake: 100, cap: 3, num: 11 }), 400);
err(call(a, 'POST', '/api/lun/create', { stake: 5, cap: 3, num: 3 }), 400);
const r1 = ok(call(a, 'POST', '/api/lun/create', { stake: 100, cap: 3, num: 1 }));
assert.equal(pts(a), 900);
err(call(a, 'POST', '/api/lun/join', { room_id: r1.id, num: 1 }), 400);
err(call(x, 'POST', '/api/lun/join', { room_id: r1.id, num: 1 }), 404);
assert.equal(ok(call(b, 'POST', '/api/lun/join', { room_id: r1.id, num: 1 })).resolved, false);
const lobby = ok(call(c, 'GET', '/api/lun'));
assert.equal(lobby.rooms[0].count, 2); assert.equal(lobby.rooms[0].my_num, null);
assert.ok(!/"num"/.test(JSON.stringify(lobby.rooms)), '대기 중인 방 응답에 숫자(num)가 있으면 안 됨');
assert.equal(ok(call(x, 'GET', '/api/lun')).rooms.length, 0);
assert.equal(ok(call(c, 'POST', '/api/lun/join', { room_id: r1.id, num: 3 })).resolved, true);      // [1,1,3] → 3
assert.deepEqual([pts(a), pts(b), pts(c)], [900, 900, 1200]);
const rec = ok(call(c, 'GET', '/api/lun')).recent[0];
assert.equal(rec.winner.name, '씨이'); assert.equal(rec.net, 200);
assert.deepEqual(rec.players.map((p) => [p.num, p.unique]), [[1, false], [1, false], [3, true]]);
err(call(d, 'POST', '/api/lun/join', { room_id: r1.id, num: 2 }), 400);
const r2 = ok(call(a, 'POST', '/api/lun/create', { stake: 50, cap: 3, num: 5 }));
ok(call(b, 'POST', '/api/lun/join', { room_id: r2.id, num: 5 })); ok(call(c, 'POST', '/api/lun/join', { room_id: r2.id, num: 5 }));
assert.equal(total(), 5000); assert.equal(pts(a), 900);
assert.equal(ok(call(a, 'GET', '/api/lun')).recent[0].winner, null);
const r3 = ok(call(a, 'POST', '/api/lun/create', { stake: 100, cap: 6, num: 2 }));
ok(call(b, 'POST', '/api/lun/join', { room_id: r3.id, num: 4 }));
err(call(a, 'POST', '/api/lun/start', { room_id: r3.id }), 400);
ok(call(c, 'POST', '/api/lun/join', { room_id: r3.id, num: 2 }));
err(call(b, 'POST', '/api/lun/start', { room_id: r3.id }), 403);
assert.equal(ok(call(a, 'POST', '/api/lun/start', { room_id: r3.id })).resolved, true);
assert.equal(pts(b), 1100);
const before = [pts(a), pts(b)];
const r4 = ok(call(a, 'POST', '/api/lun/create', { stake: 200, cap: 4, num: 1 }));
ok(call(b, 'POST', '/api/lun/join', { room_id: r4.id, num: 2 }));
err(call(b, 'POST', '/api/lun/cancel', { room_id: r4.id }), 403);
ok(call(a, 'POST', '/api/lun/cancel', { room_id: r4.id }));
assert.deepEqual([pts(a), pts(b)], before);
assert.equal(total(), 5000);
// 12시간 지난 방은 자동 환불 (락 재진입 없이)
const r5 = ok(call(d, 'POST', '/api/lun/create', { stake: 100, cap: 3, num: 4 }));
ok(call(b, 'POST', '/api/lun/join', { room_id: r5.id, num: 6 }));
const [pd, pbb] = [pts(d), pts(b)];
vm.runInContext(`var o = tbl('lun').find(function(r){return r.id===${r5.id}}); o.created_at = Date.now() - 13*3600e3; tbl('lun').save(o);`, sb);
assert.equal(ok(call(a, 'GET', '/api/lun')).rooms.some((r) => r.id === r5.id), false);
assert.deepEqual([pts(d), pts(b)], [pd + 100, pbb + 100]);

/* ===== 🪜 사다리타기 ===== */
err(call(a, 'POST', '/api/ladder/create', { stake: 100, slots: 7, slot: 0 }), 400);
err(call(a, 'POST', '/api/ladder/create', { stake: 100, slots: 3, slot: 3 }), 400);
const l1 = ok(call(a, 'POST', '/api/ladder/create', { stake: 100, slots: 3, slot: 1 }));
err(call(b, 'POST', '/api/ladder/join', { room_id: l1.id, slot: 1 }), 400);
err(call(x, 'POST', '/api/ladder/join', { room_id: l1.id, slot: 0 }), 404);
const mid = ok(call(b, 'GET', '/api/ladder'));
assert.deepEqual(mid.rooms[0].seats.map((s) => s && s.name), [null, '에이', null]);
assert.ok(!/rungs|win_end/.test(JSON.stringify(mid.rooms)), '결판 전에는 사다리가 존재하지 않음');
ok(call(b, 'POST', '/api/ladder/join', { room_id: l1.id, slot: 0 }));
assert.equal(ok(call(c, 'POST', '/api/ladder/join', { room_id: l1.id, slot: 2 })).resolved, true);
const lr = ok(call(a, 'GET', '/api/ladder')).recent[0];
assert.equal(lr.rungs.length, G.LADDER.ROWS);
const winners = lr.seats.filter((s) => s.end === lr.win_end);
assert.equal(winners.length, 1); assert.equal(winners[0].name, lr.winner.name);
assert.deepEqual(lr.seats.map((s) => s.end).sort(), [0, 1, 2]);
assert.equal(total(), 5000);
const l2 = ok(call(d, 'POST', '/api/ladder/create', { stake: 100, slots: 4, slot: 0 }));
const pd2 = pts(d);
err(call(a, 'POST', '/api/ladder/cancel', { room_id: l2.id }), 403);
ok(call(d, 'POST', '/api/ladder/cancel', { room_id: l2.id }));
assert.equal(pts(d), pd2 + 100);

/* ===== 🃏 블랙잭 ===== */
const origDeck = G.bjNewDeck;
const play = (order, token, bet, steps = []) => {
  G.bjNewDeck = () => rig(order);
  try { let r = call(token, 'POST', '/api/blackjack/start', { bet }); for (const s of steps) r = call(token, 'POST', '/api/blackjack/' + s, {}); return r; }
  finally { G.bjNewDeck = origDeck; }
};
err(call(a, 'POST', '/api/blackjack/start', { bet: 5 }), 400); err(call(a, 'POST', '/api/blackjack/start', { bet: 501 }), 400);
err(call(a, 'POST', '/api/blackjack/hit', {}), 400);
let p0 = pts(a), r;
r = play(['A', '9', 'K', '7'], a, 100); assert.equal(r.data.game.outcome, 'blackjack'); assert.equal(pts(a), p0 + 150);
p0 = pts(a); r = play(['9', 'A', '7', 'K'], a, 100); assert.equal(r.data.game.outcome, 'lose'); assert.equal(pts(a), p0 - 100); assert.equal(r.data.game.dealer[1].rank, 'K');
p0 = pts(a); r = play(['10', '9', '8', '7', '5'], a, 100);
assert.equal(r.data.game.status, 'playing'); assert.equal(r.data.game.dealer[1], null, '진행 중에는 딜러 둘째 카드가 응답에 없음');
assert.ok(!/"deck"/.test(JSON.stringify(r)), '남은 덱이 응답에 없음');
err(call(a, 'POST', '/api/blackjack/start', { bet: 10 }), 400);
assert.equal(pts(a), p0 - 100);
let st = ok(call(a, 'POST', '/api/blackjack/stand', {})).game;
assert.equal(st.outcome, 'lose'); assert.equal(st.dealer.length, 3);
p0 = pts(a); r = play(['10', '9', '8', '7', 'K'], a, 100, ['stand']); assert.equal(r.data.game.outcome, 'win'); assert.equal(pts(a), p0 + 100);
p0 = pts(a); r = play(['10', '9', '6', '7', 'K'], a, 100, ['hit']); assert.equal(r.data.game.outcome, 'bust'); assert.equal(pts(a), p0 - 100);
p0 = pts(a); r = play(['5', '10', '6', '7', '10'], a, 100, ['double']);
assert.equal(r.data.game.outcome, 'win'); assert.equal(r.data.game.wagered, 200); assert.equal(pts(a), p0 + 200);
r = play(['5', '10', '6', '7', '2', '3'], a, 100, ['hit']);
err(call(a, 'POST', '/api/blackjack/double', {}), 400);
call(a, 'POST', '/api/blackjack/stand', {});
assert.ok(ok(call(a, 'GET', '/api/blackjack')).recent.length >= 5);
// 무작위 판 100번: 정산 항등식
for (let i = 0; i < 100; i++) {
  const before = pts(d); if (before < 40) break;
  let g = ok(call(d, 'POST', '/api/blackjack/start', { bet: 20 })).game, guard = 0;
  while (g.status === 'playing' && guard++ < 20) g = ok(call(d, 'POST', '/api/blackjack/' + (g.pv.total < 15 ? 'hit' : 'stand'), {})).game;
  assert.equal(g.status, 'done'); assert.equal(pts(d), before - g.wagered + g.payout, '정산 항등식');
}
// 더블다운에 포인트 부족: 정확히 100점인 사람이 100 걸면 남은 돈이 0 → 더블다운 불가
{ const poor = mk('가난', '4444');
  vm.runInContext("var u = tbl('users').find(function (x) { return x.name === '가난'; }); u.points = 100; tbl('users').save(u);", sb);
  const r2 = play(['5', '10', '6', '7', '2'], poor, 100);
  assert.equal(r2.data.game.status, 'playing'); assert.equal(pts(poor), 0);
  err(call(poor, 'POST', '/api/blackjack/double', {}), 400);
  assert.equal(ok(call(poor, 'POST', '/api/blackjack/stand', {})).game.status, 'done'); }

/* ===== 🎰 슬롯머신 ===== */
const origSpin = G.slotSpin;
err(call(b, 'POST', '/api/slots/spin', { bet: 5 }), 400); err(call(b, 'POST', '/api/slots/spin', { bet: 501 }), 400);
let s0 = pts(b);
G.slotSpin = () => ({ reels: [5, 5, 5], mult: 200 });
let sr = ok(call(b, 'POST', '/api/slots/spin', { bet: 10 }));
assert.deepEqual(sr.reels, ['7️⃣', '7️⃣', '7️⃣']); assert.equal(sr.payout, 2000); assert.equal(pts(b), s0 + 1990);
G.slotSpin = () => ({ reels: [1, 2, 3], mult: 0 }); s0 = pts(b); sr = ok(call(b, 'POST', '/api/slots/spin', { bet: 50 }));
assert.equal(sr.net, -50); assert.equal(pts(b), s0 - 50);
G.slotSpin = () => ({ reels: [0, 1, 2], mult: 0.5 }); s0 = pts(b); sr = ok(call(b, 'POST', '/api/slots/spin', { bet: 15 }));
assert.equal(sr.payout, 7); assert.equal(pts(b), s0 - 8);
G.slotSpin = origSpin;
assert.equal(ok(call(b, 'GET', '/api/slots')).recent.length, 3); assert.equal(ok(call(b, 'GET', '/api/slots')).triple.length, 6);
err(call('', 'GET', '/api/slots'), 401);
/* ===== 혼자 하는 게임 하루 제한 ===== */
{
  const realNow = Date.now; let shift = 0; Date.now = () => realNow() + shift;
  try {
    G.SOLO.DAILY_NET_CAP = 300; G.SOLO.DAILY_PLAYS = 0;
    const w = mk('한도', '1111'), lim = () => ok(call(w, 'GET', '/api/slots')).limits;
    assert.equal(lim().remaining, 300); assert.equal(lim().blocked, null);
    G.slotSpin = () => ({ reels: [5, 5, 5], mult: 200 });
    const r1 = ok(call(w, 'POST', '/api/slots/spin', { bet: 10 }));
    assert.equal(r1.capped, true); assert.equal(r1.net, 300); assert.equal(r1.payout, 310);
    assert.equal(pts(w), 1000 - 10 + 310); assert.equal(r1.limits.blocked, 'net');
    const blocked = err(call(w, 'POST', '/api/slots/spin', { bet: 10 }), 400); assert.ok(/한도/.test(blocked.error));
    err(call(w, 'POST', '/api/blackjack/start', { bet: 10 }), 400);
    assert.equal(pts(w), 1300);
    G.slotSpin = origSpin;
    shift += 24 * 3600e3;
    assert.equal(lim().blocked, null); assert.equal(lim().net_today, 0);
    G.slotSpin = () => ({ reels: [1, 2, 3], mult: 0 }); ok(call(w, 'POST', '/api/slots/spin', { bet: 100 })); G.slotSpin = origSpin;
    assert.equal(lim().remaining, 400);
    G.SOLO.DAILY_NET_CAP = 50; shift += 24 * 3600e3;
    const p1 = pts(w); G.bjNewDeck = () => rig(['A', '9', 'K', '7']);
    const bjr = ok(call(w, 'POST', '/api/blackjack/start', { bet: 100 })); G.bjNewDeck = origDeck;
    assert.equal(bjr.game.outcome, 'blackjack'); assert.equal(bjr.game.capped, true); assert.equal(bjr.game.net, 50); assert.equal(pts(w), p1 + 50); assert.equal(bjr.limits.blocked, 'net');
    G.SOLO.DAILY_NET_CAP = 0; G.SOLO.DAILY_PLAYS = 2; shift += 24 * 3600e3;
    G.slotSpin = () => ({ reels: [1, 2, 3], mult: 0 });
    ok(call(w, 'POST', '/api/slots/spin', { bet: 10 })); assert.equal(lim().plays_left, 1);
    ok(call(w, 'POST', '/api/slots/spin', { bet: 10 }));
    const over = err(call(w, 'POST', '/api/slots/spin', { bet: 10 }), 400); assert.ok(/2번/.test(over.error));
    assert.equal(lim().blocked, 'plays');
    shift += 24 * 3600e3; ok(call(w, 'POST', '/api/slots/spin', { bet: 10 }));
  } finally { Date.now = realNow; G.slotSpin = origSpin; G.bjNewDeck = origDeck; G.SOLO.DAILY_NET_CAP = 0; G.SOLO.DAILY_PLAYS = 0; }
}
console.log('GAS 새 게임 테스트 통과');
