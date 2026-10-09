process.env.DB_FILE = ':memory:';
const assert = require('node:assert');
const { server } = require('./server');
server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const call = async (m, p, b, t) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
    return { s: r.status, j: await r.json() };
  };
  const mk = async (name) => (await call('POST', '/api/signup', { name, pin: '1234' })).j.token;
  const pts = async (t) => (await call('GET', '/api/me', null, t)).j.points;
  try {
    const [a, b, c, d] = await Promise.all(['a', 'b', 'c', 'd'].map(mk));
    assert.equal((await call('POST', '/api/login', { name: 'a', pin: '0000' })).s, 401);

    // 역배: A(1명 100점) vs B(3명 각 100점) → 총 400, 이긴 쪽 비중 25% < 30% → 보너스 20%(80)
    const bet = (await call('POST', '/api/bets', { title: '테스트', options: ['X', 'Y'] }, a)).j;
    const [X, Y] = bet.options.map((o) => o.id);
    assert.equal((await call('POST', '/api/wager', { option_id: X, amount: 100 }, a)).s, 200);
    for (const t of [b, c, d]) await call('POST', '/api/wager', { option_id: Y, amount: 100 }, t);
    assert.equal((await call('POST', '/api/wager', { option_id: Y, amount: 100 }, a)).s, 400, '헷지 금지');
    assert.equal((await call('POST', '/api/wager', { option_id: Y, amount: 5 }, b)).s, 400, '최소금액');
    assert.equal((await call('POST', '/api/wager', { option_id: Y, amount: 99999 }, b)).s, 400, '잔액 초과');
    assert.equal((await call('POST', '/api/bets/action', { bet_id: bet.id, action: 'resolve', option_id: X }, b)).s, 403, '개설자만');
    await call('POST', '/api/bets/action', { bet_id: bet.id, action: 'close' }, a);
    assert.equal((await call('POST', '/api/wager', { option_id: Y, amount: 10 }, b)).s, 400, '마감 후 베팅 금지');
    await call('POST', '/api/bets/action', { bet_id: bet.id, action: 'resolve', option_id: X }, a);
    assert.equal(await pts(a), 900 + 480);   // 400 + 보너스 80
    assert.equal(await pts(b), 900);
    assert.equal(await pts(c), 900);

    // 일반 정산: 2:2 → 이긴 쪽이 상대 판돈을 비례 분배, 총합 보존
    const bet2 = (await call('POST', '/api/bets', { title: '2', options: ['P', 'Q'] }, b)).j;
    const [P, Q] = bet2.options.map((o) => o.id);
    await call('POST', '/api/wager', { option_id: P, amount: 100 }, b);
    await call('POST', '/api/wager', { option_id: P, amount: 200 }, c);
    await call('POST', '/api/wager', { option_id: Q, amount: 300 }, d);
    const before = (await Promise.all([a, b, c, d].map(pts))).reduce((x, y) => x + y);
    await call('POST', '/api/bets/action', { bet_id: bet2.id, action: 'resolve', option_id: P }, b);
    const after = (await Promise.all([a, b, c, d].map(pts))).reduce((x, y) => x + y);
    assert.equal(after - before, 600, '총 판돈 600이 그대로 지급(보너스 없음)');
    assert.equal(await pts(d), 600);

    // 아무도 못 맞히면 환불
    const bet3 = (await call('POST', '/api/bets', { title: '3', options: ['M', 'N'] }, a)).j;
    await call('POST', '/api/wager', { option_id: bet3.options[0].id, amount: 50 }, a);
    await call('POST', '/api/bets/action', { bet_id: bet3.id, action: 'resolve', option_id: bet3.options[1].id }, a);
    assert.equal(await pts(a), 1380 - 50 + 50);
    console.log('모든 테스트 통과');
    process.exitCode = 0;
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();
});
