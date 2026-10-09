process.env.DB_FILE = ':memory:';
const assert = require('node:assert');
const { server } = require('./server');
server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const call = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json(), raw: null }; };
  const mk = async (n) => (await call('POST', '/api/signup', { name: n, pin: '1234' })).j.token;
  try {
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map(mk));
    const pts = async (t) => (await call('GET', '/api/me', null, t)).j.points;
    assert.equal((await call('GET', '/api/rps')).s, 401);

    // 방 만들기 검증
    assert.equal((await call('POST', '/api/rps/create', { hand: 'lizard', stake: 100 }, a)).s, 400);
    assert.equal((await call('POST', '/api/rps/create', { hand: 'rock', stake: 5 }, a)).s, 400, '최소 판돈');
    assert.equal((await call('POST', '/api/rps/create', { hand: 'rock', stake: 99999 }, a)).s, 400, '잔액 초과');
    const r1 = (await call('POST', '/api/rps/create', { hand: 'rock', stake: 100 }, a)).j;
    assert.equal(await pts(a), 900, '판돈은 방을 여는 순간 맡겨짐');

    // 방장의 손은 다른 사람에게 절대 안 보임 (응답 전체에서 확인)
    const lobbyB = await fetch(base + '/api/rps', { headers: { Authorization: 'Bearer ' + b } }).then((r) => r.text());
    assert.ok(!lobbyB.includes('rock'), '대기 중에는 방장의 손이 노출되면 안 됨: ' + lobbyB);
    const lobbyA = (await call('GET', '/api/rps', null, a)).j;
    assert.equal(lobbyA.rooms[0].my_hand, 'rock');           // 본인은 자기 손을 봄
    assert.equal(lobbyA.rooms[0].mine, true);

    // 본인 방 입장 금지, 잔액 부족 금지, 잘못된 손
    assert.equal((await call('POST', '/api/rps/join', { room_id: r1.id, hand: 'paper' }, a)).s, 400);
    assert.equal((await call('POST', '/api/rps/join', { room_id: r1.id, hand: 'x' }, b)).s, 400);

    // 도전자가 이김: 보 > 바위
    const j1 = (await call('POST', '/api/rps/join', { room_id: r1.id, hand: 'paper' }, b)).j;
    assert.equal(j1.outcome, 'win'); assert.equal(j1.net, 100); assert.equal(j1.host_hand, 'rock');
    assert.equal(await pts(a), 900); assert.equal(await pts(b), 1100);
    assert.equal((await call('POST', '/api/rps/join', { room_id: r1.id, hand: 'paper' }, c)).s, 400, '끝난 방에 재입장 금지');

    // 방장이 이김: 가위 > 보
    const r2 = (await call('POST', '/api/rps/create', { hand: 'scissors', stake: 200 }, a)).j;
    const j2 = (await call('POST', '/api/rps/join', { room_id: r2.id, hand: 'paper' }, b)).j;
    assert.equal(j2.outcome, 'lose'); assert.equal(j2.net, -200);
    assert.equal(await pts(a), 900 - 200 + 400); assert.equal(await pts(b), 1100 - 200);

    // 비김: 각자 원금
    const r3 = (await call('POST', '/api/rps/create', { hand: 'paper', stake: 50 }, a)).j;
    const [a0, c0] = [await pts(a), await pts(c)];
    const j3 = (await call('POST', '/api/rps/join', { room_id: r3.id, hand: 'paper' }, c)).j;
    assert.equal(j3.outcome, 'draw');
    assert.equal(await pts(a), a0 + 50); assert.equal(await pts(c), c0);

    // 기록: 결판 뒤에는 양쪽 손이 공개되고, 각자 시점의 손익이 맞음
    const recA = (await call('GET', '/api/rps', null, a)).j.recent;
    assert.equal(recA.length, 3);
    assert.deepEqual(recA.map((r) => r.net).sort(), [-100, 0, 200].sort());   // 방장 a: 졌음(-100) / 이김(+200) / 비김(0)
    const recC = (await call('GET', '/api/rps', null, c)).j.recent;
    assert.equal(recC.filter((r) => r.mine).length, 1);
    assert.equal(recC.find((r) => r.mine).net, 0);

    // 방 닫기: 방장만, 환불
    const r4 = (await call('POST', '/api/rps/create', { hand: 'rock', stake: 300 }, a)).j;
    const before = await pts(a);
    assert.equal((await call('POST', '/api/rps/cancel', { room_id: r4.id }, b)).s, 403);
    assert.equal((await call('POST', '/api/rps/cancel', { room_id: r4.id }, a)).s, 200);
    assert.equal(await pts(a), before + 300);
    assert.equal((await call('POST', '/api/rps/join', { room_id: r4.id, hand: 'rock' }, c)).s, 400, '닫힌 방');

    // 동시 방 3개 제한
    for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/rps/create', { hand: 'rock', stake: 10 }, a)).s, 200);
    assert.equal((await call('POST', '/api/rps/create', { hand: 'rock', stake: 10 }, a)).s, 400);

    // 전체 포인트 보존(비기거나 이기고 지는 것만 → 합계 불변)
    const total = (await Promise.all([a, b, c].map(pts))).reduce((x, y) => x + y) + 30; // 열려있는 방 3개(10×3)는 맡겨진 상태
    assert.equal(total, 3000);
    console.log('가위바위보 테스트 통과');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();
});
