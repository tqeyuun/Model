// 새 게임 4종(최저 유일 숫자, 사다리타기, 블랙잭, 슬롯머신) 서버 통합 테스트
process.env.DB_FILE = ':memory:';
const assert = require('node:assert');
const G = require('./games-core');           // 서버와 같은 모듈 → 카드/난수를 고정해서 정산을 정확히 검증
const { server, db } = require('./server');
G.SOLO.DAILY_NET_CAP = 0; G.SOLO.DAILY_PLAYS = 0;   // 기존 게임 검증은 하루 제한 없이 (제한은 맨 아래에서 따로 검증)
const rankIdx = { A: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9, J: 10, Q: 11, K: 12 };
const rig = (order) => { const first = order.map((r) => rankIdx[r]); const used = {}; first.forEach((c) => { used[c] = (used[c] || 0) + 1; });
  // 같은 숫자 카드를 여러 장 쓰려면 다른 무늬 코드로 대체
  const codes = []; const seen = {}; first.forEach((r) => { const k = seen[r] = (seen[r] || 0); seen[r]++; codes.push(r + 13 * k); });
  const rest = Array.from({ length: 52 }, (_, i) => i).filter((c) => !codes.includes(c)); return [...codes, ...rest]; };

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const call = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); const raw = await r.text(); return { s: r.status, j: JSON.parse(raw), raw }; };
  const mk = async (n, pin = '1111') => (await call('POST', '/api/signup', { name: n, pin })).j.token;
  const pts = async (t) => (await call('GET', '/api/me', null, t)).j.points;
  try {
    const [a, b, c, d] = [await mk('에이'), await mk('비이'), await mk('씨이'), await mk('디이')];
    const x = await mk('엑스', '9999');   // 다른 PIN 방
    const total = async () => (await Promise.all([a, b, c, d, x].map(pts))).reduce((p, q) => p + q);
    assert.equal(await total(), 5000);

    /* ================= 🤫 최저 유일 숫자 ================= */
    assert.equal((await call('POST', '/api/lun/create', { stake: 100, cap: 2, num: 3 }, a)).s, 400, '최소 3명');
    assert.equal((await call('POST', '/api/lun/create', { stake: 100, cap: 3, num: 11 }, a)).s, 400, '숫자 범위');
    assert.equal((await call('POST', '/api/lun/create', { stake: 5, cap: 3, num: 3 }, a)).s, 400, '최소 판돈');
    const r1 = (await call('POST', '/api/lun/create', { stake: 100, cap: 3, num: 1 }, a)).j;
    assert.equal(await pts(a), 900);
    assert.equal((await call('POST', '/api/lun/join', { room_id: r1.id, num: 1 }, a)).s, 400, '같은 방에 두 번 못 들어감');
    assert.equal((await call('POST', '/api/lun/join', { room_id: r1.id, num: 1 }, x)).s, 404, '다른 PIN 방은 못 들어옴');
    assert.equal((await call('POST', '/api/lun/join', { room_id: r1.id, num: 1 }, b)).j.resolved, false);
    // 결판 전에는 다른 사람의 숫자가 응답 어디에도 없어야 함
    const lobby = (await call('GET', '/api/lun', null, c)).j;
    assert.equal(lobby.rooms[0].count, 2); assert.equal(lobby.rooms[0].my_num, null);
    assert.ok(!/"num"/.test(JSON.stringify(lobby.rooms)), '대기 중인 방 응답에 숫자(num)가 있으면 안 됨');
    assert.equal((await call('GET', '/api/lun', null, x)).j.rooms.length, 0, '다른 방에는 안 보임');
    const last = (await call('POST', '/api/lun/join', { room_id: r1.id, num: 3 }, c)).j;   // [1, 1, 3] → 3 이 이김
    assert.equal(last.resolved, true);
    assert.equal(await pts(a), 900); assert.equal(await pts(b), 900); assert.equal(await pts(c), 900 + 300);
    const rec = (await call('GET', '/api/lun', null, c)).j.recent[0];
    assert.equal(rec.winner.name, '씨이'); assert.equal(rec.net, 200);
    assert.deepEqual(rec.players.map((p) => [p.num, p.unique]), [[1, false], [1, false], [3, true]], '결판 뒤에는 모두의 숫자가 공개');
    assert.equal((await call('POST', '/api/lun/join', { room_id: r1.id, num: 2 }, d)).s, 400, '끝난 방');
    // 전부 겹침 → 환불
    const r2 = (await call('POST', '/api/lun/create', { stake: 50, cap: 3, num: 5 }, a)).j;
    await call('POST', '/api/lun/join', { room_id: r2.id, num: 5 }, b); await call('POST', '/api/lun/join', { room_id: r2.id, num: 5 }, c);
    assert.equal(await total(), 5000); assert.equal(await pts(a), 900);
    assert.equal((await call('GET', '/api/lun', null, a)).j.recent[0].winner, null);
    // 방장 시작: 3명 이상일 때만, 정원 미달이어도
    const r3 = (await call('POST', '/api/lun/create', { stake: 100, cap: 6, num: 2 }, a)).j;
    await call('POST', '/api/lun/join', { room_id: r3.id, num: 4 }, b);
    assert.equal((await call('POST', '/api/lun/start', { room_id: r3.id }, a)).s, 400, '2명으로는 시작 불가');
    await call('POST', '/api/lun/join', { room_id: r3.id, num: 2 }, c);          // [2,4,2] → 4 가 이김
    assert.equal((await call('POST', '/api/lun/start', { room_id: r3.id }, b)).s, 403, '방장만 시작');
    assert.equal((await call('POST', '/api/lun/start', { room_id: r3.id }, a)).j.resolved, true);
    assert.equal(await pts(b), 1100, '승자 b: 직전 900점에서 100 걸고 300 받음');
    // 방 닫기: 모두 환불
    const before = [await pts(a), await pts(b)];
    const r4 = (await call('POST', '/api/lun/create', { stake: 200, cap: 4, num: 1 }, a)).j;
    await call('POST', '/api/lun/join', { room_id: r4.id, num: 2 }, b);
    assert.equal((await call('POST', '/api/lun/cancel', { room_id: r4.id }, b)).s, 403);
    assert.equal((await call('POST', '/api/lun/cancel', { room_id: r4.id }, a)).s, 200);
    assert.deepEqual([await pts(a), await pts(b)], before, '닫으면 참가자 모두 환불');
    assert.equal(await total(), 5000, '사람끼리 하는 게임은 포인트 총합이 변하지 않음');

    /* ================= 🪜 사다리타기 ================= */
    assert.equal((await call('POST', '/api/ladder/create', { stake: 100, slots: 7, slot: 0 }, a)).s, 400);
    assert.equal((await call('POST', '/api/ladder/create', { stake: 100, slots: 3, slot: 3 }, a)).s, 400);
    const l1 = (await call('POST', '/api/ladder/create', { stake: 100, slots: 3, slot: 1 }, a)).j;
    assert.equal((await call('POST', '/api/ladder/join', { room_id: l1.id, slot: 1 }, b)).s, 400, '이미 앉은 자리');
    assert.equal((await call('POST', '/api/ladder/join', { room_id: l1.id, slot: 0 }, x)).s, 404, '다른 PIN 방');
    const mid = (await call('GET', '/api/ladder', null, b)).j;
    assert.deepEqual(mid.rooms[0].seats.map((s) => s && s.name), [null, '에이', null]);
    assert.ok(!/rungs|win_end/.test(JSON.stringify(mid.rooms)), '결판 전에는 사다리가 존재하지 않음');
    const pb = await pts(b);
    await call('POST', '/api/ladder/join', { room_id: l1.id, slot: 0 }, b);
    const done = await call('POST', '/api/ladder/join', { room_id: l1.id, slot: 2 }, c);
    assert.equal(done.j.resolved, true);
    const lr = (await call('GET', '/api/ladder', null, a)).j.recent[0];
    assert.equal(lr.rungs.length, G.LADDER.ROWS);
    const winners = lr.seats.filter((s) => s.end === lr.win_end);
    assert.equal(winners.length, 1, '당첨 끝 칸에 도착한 사람은 정확히 한 명'); assert.equal(winners[0].name, lr.winner.name);
    assert.deepEqual(lr.seats.map((s) => s.end).sort(), [0, 1, 2], '서로 다른 끝 칸');
    assert.equal(lr.seats[0].path[lr.seats[0].path.length - 1], lr.seats[0].end);
    assert.equal(await total(), 5000);
    const winnerTok = { 에이: a, 비이: b, 씨이: c }[lr.winner.name];
    assert.equal(lr.mine && (await call('GET', '/api/ladder', null, winnerTok)).j.recent[0].net, 200);
    // 방 닫기
    const l2 = (await call('POST', '/api/ladder/create', { stake: 100, slots: 4, slot: 0 }, d)).j;
    const pd = await pts(d);
    assert.equal((await call('POST', '/api/ladder/cancel', { room_id: l2.id }, a)).s, 403);
    assert.equal((await call('POST', '/api/ladder/cancel', { room_id: l2.id }, d)).s, 200);
    assert.equal(await pts(d), pd + 100);

    /* ================= 🃏 블랙잭 ================= */
    const origDeck = G.bjNewDeck;
    const play = async (order, token, bet, steps = []) => {
      G.bjNewDeck = () => rig(order);
      try {
        let r = await call('POST', '/api/blackjack/start', { bet }, token);
        for (const s of steps) r = await call('POST', '/api/blackjack/' + s, {}, token);
        return r;
      } finally { G.bjNewDeck = origDeck; }
    };
    assert.equal((await call('POST', '/api/blackjack/start', { bet: 5 }, a)).s, 400, '최소');
    assert.equal((await call('POST', '/api/blackjack/start', { bet: 501 }, a)).s, 400, '최대');
    assert.equal((await call('POST', '/api/blackjack/hit', {}, a)).s, 400, '판이 없을 때');
    // 덱 순서: 플레이어1, 딜러1, 플레이어2, 딜러2, 이후 뽑는 카드들
    let p0 = await pts(a);
    let r = await play(['A', '9', 'K', '7'], a, 100);                   // 플레이어 블랙잭 → 3:2
    assert.equal(r.j.game.outcome, 'blackjack'); assert.equal(await pts(a), p0 + 150);
    p0 = await pts(a);
    r = await play(['9', 'A', '7', 'K'], a, 100);                       // 딜러 블랙잭 → 패배, 딜러 카드 공개
    assert.equal(r.j.game.outcome, 'lose'); assert.equal(await pts(a), p0 - 100); assert.equal(r.j.game.dealer[1].rank, 'K');
    p0 = await pts(a);
    r = await play(['10', '9', '8', '7', '5'], a, 100);                 // 18 vs 16 → 딜러 5 받아 21
    assert.equal(r.j.game.status, 'playing');
    assert.equal(r.j.game.dealer[1], null, '진행 중에는 딜러 둘째 카드가 응답에 없음');
    assert.ok(!/"deck"/.test(r.raw), '남은 덱이 응답에 없음');
    assert.equal((await call('POST', '/api/blackjack/start', { bet: 10 }, a)).s, 400, '진행 중인 판이 있으면 새로 못 함');
    assert.equal(await pts(a), p0 - 100, '건 돈은 시작할 때 빠짐');
    const st = (await call('POST', '/api/blackjack/stand', {}, a)).j.game;
    assert.equal(st.outcome, 'lose'); assert.equal(st.dealer.length, 3); assert.equal(await pts(a), p0 - 100);
    p0 = await pts(a);
    r = await play(['10', '9', '8', '7', 'K'], a, 100, ['stand']);       // 18 vs 16+K=26 버스트 → 승
    assert.equal(r.j.game.outcome, 'win'); assert.equal(await pts(a), p0 + 100);
    p0 = await pts(a);
    r = await play(['10', '9', '6', '7', 'K'], a, 100, ['hit']);         // 16 + K = 26 → 버스트
    assert.equal(r.j.game.outcome, 'bust'); assert.equal(await pts(a), p0 - 100);
    p0 = await pts(a);
    r = await play(['5', '10', '6', '7', '10'], a, 100, ['double']);     // 11 + 10 = 21, 딜러 17 → 승. 200 걸고 400 받음
    assert.equal(r.j.game.outcome, 'win'); assert.equal(r.j.game.wagered, 200); assert.equal(await pts(a), p0 + 200);
    p0 = await pts(a);
    r = await play(['5', '10', '6', '7', '2', '3'], a, 100, ['hit']);    // 11+2=13 진행 중
    assert.equal((await call('POST', '/api/blackjack/double', {}, a)).s, 400, '히트한 뒤엔 더블다운 불가');
    await call('POST', '/api/blackjack/stand', {}, a);
    // 더블다운에 포인트 부족: 정확히 100점인 사람이 100 걸면 남은 돈이 0 → 더블다운 불가
    { const poor = await mk('가난', '4444');
      db.prepare("UPDATE users SET points=100 WHERE name='가난'").run();
      const r2 = await play(['5', '10', '6', '7', '2'], poor, 100);
      assert.equal(r2.j.game.status, 'playing'); assert.equal(await pts(poor), 0);
      assert.equal((await call('POST', '/api/blackjack/double', {}, poor)).s, 400);
      assert.equal((await call('POST', '/api/blackjack/stand', {}, poor)).j.game.status, 'done'); }
    // 기록
    const bv = (await call('GET', '/api/blackjack', null, a)).j;
    assert.ok(bv.recent.length >= 5); assert.equal(bv.rules.MAX_BET, 500);
    // 무작위 판 100번: 정산 항등식 (끝난 뒤 포인트 = 시작 - 건 돈 + 받은 돈)
    G.bjNewDeck = origDeck;
    for (let i = 0; i < 100; i++) {
      const before = await pts(d);
      if (before < 40) break;
      let g = (await call('POST', '/api/blackjack/start', { bet: 20 }, d)).j.game;
      let guard = 0;
      while (g.status === 'playing' && guard++ < 20) g = (await call('POST', '/api/blackjack/' + (g.pv.total < 15 ? 'hit' : 'stand'), {}, d)).j.game;
      assert.equal(g.status, 'done');
      assert.equal(await pts(d), before - g.wagered + g.payout, '정산 항등식');
      assert.equal(g.net, g.payout - g.wagered);
    }

    /* ================= 🎰 슬롯머신 ================= */
    const origSpin = G.slotSpin;
    assert.equal((await call('POST', '/api/slots/spin', { bet: 5 }, b)).s, 400); assert.equal((await call('POST', '/api/slots/spin', { bet: 501 }, b)).s, 400);
    let s0 = await pts(b);
    G.slotSpin = () => ({ reels: [5, 5, 5], mult: 200 });
    let sr = (await call('POST', '/api/slots/spin', { bet: 10 }, b)).j;
    assert.deepEqual(sr.reels, ['7️⃣', '7️⃣', '7️⃣']); assert.equal(sr.payout, 2000); assert.equal(await pts(b), s0 + 1990);
    G.slotSpin = () => ({ reels: [1, 2, 3], mult: 0 });
    s0 = await pts(b); sr = (await call('POST', '/api/slots/spin', { bet: 50 }, b)).j;
    assert.equal(sr.net, -50); assert.equal(await pts(b), s0 - 50);
    G.slotSpin = () => ({ reels: [0, 1, 2], mult: 0.5 });
    s0 = await pts(b); sr = (await call('POST', '/api/slots/spin', { bet: 15 }, b)).j;
    assert.equal(sr.payout, 7); assert.equal(await pts(b), s0 - 8);
    G.slotSpin = origSpin;
    assert.equal((await call('GET', '/api/slots', null, b)).j.recent.length, 3);
    assert.equal((await call('GET', '/api/slots', null, b)).j.triple.length, 6);
    assert.equal((await call('GET', '/api/slots', null)).s, 401);

    /* ================= 연타 방지: 같은 조건의 방/도박을 바로 또 만들 수 없음 ================= */
    { const t = await mk('연타', '1111');
      const dup = async (p, b) => [(await call('POST', p, b, t)).s, (await call('POST', p, b, t)).s];
      assert.deepEqual(await dup('/api/lun/create', { stake: 20, cap: 3, num: 1 }), [200, 409]);
      assert.deepEqual(await dup('/api/ladder/create', { stake: 20, slots: 3, slot: 0 }), [200, 409]);
      assert.deepEqual(await dup('/api/bets', { title: '연타 도박', options: ['x', 'y'] }), [200, 409]);
      assert.equal((await call('POST', '/api/lun/create', { stake: 30, cap: 3, num: 1 }, t)).s, 200, '조건이 다르면 만들 수 있음'); }

    /* ================= 혼자 하는 게임 하루 제한 ================= */
    const realNow = Date.now; let shift = 0; Date.now = () => realNow() + shift;       // 날짜를 건너뛰어서 자정 초기화 검증
    try {
      G.SOLO.DAILY_NET_CAP = 300; G.SOLO.DAILY_PLAYS = 0;
      const w = await mk('한도', '1111');
      const lim = async () => (await call('GET', '/api/slots', null, w)).j.limits;
      assert.equal((await lim()).remaining, 300); assert.equal((await lim()).blocked, null);
      G.slotSpin = () => ({ reels: [5, 5, 5], mult: 200 });                             // 원래는 +1990
      let r1 = (await call('POST', '/api/slots/spin', { bet: 10 }, w)).j;
      assert.equal(r1.capped, true); assert.equal(r1.net, 300, '한도(300)까지만 지급'); assert.equal(r1.payout, 310);
      assert.equal(await pts(w), 1000 - 10 + 310);
      assert.equal(r1.limits.blocked, 'net'); assert.equal(r1.limits.net_today, 300);
      const blocked = await call('POST', '/api/slots/spin', { bet: 10 }, w);
      assert.equal(blocked.s, 400); assert.ok(/한도/.test(blocked.j.error), blocked.j.error);
      assert.equal((await call('POST', '/api/blackjack/start', { bet: 10 }, w)).s, 400, '블랙잭도 같은 한도를 같이 씀');
      assert.equal(await pts(w), 1300, '막힌 요청에서는 포인트가 안 빠짐');
      G.slotSpin = origSpin;
      // 자정이 지나면 초기화
      shift += 24 * 3600e3;
      assert.equal((await lim()).blocked, null); assert.equal((await lim()).net_today, 0);
      // 잃으면 한도 여유가 늘어남: -100 → 이날은 400까지 벌 수 있음
      G.slotSpin = () => ({ reels: [1, 2, 3], mult: 0 });
      await call('POST', '/api/slots/spin', { bet: 100 }, w);
      assert.equal((await lim()).remaining, 400);
      G.slotSpin = origSpin;
      // 블랙잭: 블랙잭(원래 +150)이 남은 한도 안으로 잘림
      G.SOLO.DAILY_NET_CAP = 50; shift += 24 * 3600e3;
      const p1 = await pts(w);
      G.bjNewDeck = () => rig(['A', '9', 'K', '7']);
      const bjr = (await call('POST', '/api/blackjack/start', { bet: 100 }, w)).j;
      G.bjNewDeck = origDeck;
      assert.equal(bjr.game.outcome, 'blackjack'); assert.equal(bjr.game.capped, true); assert.equal(bjr.game.net, 50); assert.equal(await pts(w), p1 + 50);
      assert.equal(bjr.limits.blocked, 'net');
      // 횟수 제한: 하루 2번
      G.SOLO.DAILY_NET_CAP = 0; G.SOLO.DAILY_PLAYS = 2; shift += 24 * 3600e3;
      G.slotSpin = () => ({ reels: [1, 2, 3], mult: 0 });
      assert.equal((await call('POST', '/api/slots/spin', { bet: 10 }, w)).s, 200);
      assert.equal((await lim()).plays_left, 1);
      assert.equal((await call('POST', '/api/slots/spin', { bet: 10 }, w)).s, 200);
      const over = await call('POST', '/api/slots/spin', { bet: 10 }, w);
      assert.equal(over.s, 400); assert.ok(/2번/.test(over.j.error), over.j.error);
      assert.equal((await lim()).blocked, 'plays');
      shift += 24 * 3600e3; assert.equal((await call('POST', '/api/slots/spin', { bet: 10 }, w)).s, 200, '다음 날에는 다시 가능');
    } finally { Date.now = realNow; G.slotSpin = origSpin; G.bjNewDeck = origDeck; G.SOLO.DAILY_NET_CAP = 0; G.SOLO.DAILY_PLAYS = 0; }

    console.log('새 게임 서버 테스트 통과');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();
});
