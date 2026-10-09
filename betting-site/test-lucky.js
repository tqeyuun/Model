// 럭키 확률 100%로 강제해서 보너스 지급을 확인
process.env.DB_FILE = ':memory:';
process.env.LUCKY_CHANCE = '1';
const assert = require('node:assert');
const { server } = require('./server');
server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const call = async (m, p, b, t) => (await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined })).json();
  try {
    const a = (await call('POST', '/api/signup', { name: 'a', pin: '1234' })).token;
    const b = (await call('POST', '/api/signup', { name: 'b', pin: '1234' })).token;
    const bet = await call('POST', '/api/bets', { title: 't', options: ['X', 'Y'] }, a);
    await call('POST', '/api/wager', { option_id: bet.options[0].id, amount: 100 }, a);
    await call('POST', '/api/wager', { option_id: bet.options[1].id, amount: 100 }, b);
    await call('POST', '/api/bets/action', { bet_id: bet.id, action: 'resolve', option_id: bet.options[0].id }, a);
    assert.equal((await call('GET', '/api/me', null, a)).points, 900 + 200 + 100); // 200 + 럭키 50%
    const v = (await call('GET', '/api/bets', null, a))[0];
    assert.equal(v.my_lucky, true);
    console.log('럭키 테스트 통과');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();
});
