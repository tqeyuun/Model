process.env.DB_FILE = ':memory:';
const assert = require('node:assert');
const { server } = require('./server');
server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const call = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json() }; };
  try {
    const t = (await call('POST', '/api/signup', { name: 'shopper', pin: '1234' })).j.token;
    const pts = async () => (await call('GET', '/api/me', null, t)).j.points;
    assert.equal((await call('GET', '/api/shop')).s, 401);
    const list = (await call('GET', '/api/shop', null, t)).j;
    assert.ok(list.length > 10 && list.every((i) => !i.owned && !i.equipped));
    assert.equal((await call('POST', '/api/shop/buy', { item_id: 't_legend' }, t)).s, 400, '포인트 부족');
    assert.equal((await call('POST', '/api/shop/buy', { item_id: 'nope' }, t)).s, 404);
    assert.equal((await call('POST', '/api/shop/equip', { item_id: 't_gambler' }, t)).s, 400, '안 산 건 장착 불가');
    assert.equal((await call('POST', '/api/shop/buy', { item_id: 't_gambler' }, t)).s, 200);
    assert.equal(await pts(), 700);
    assert.equal((await call('POST', '/api/shop/buy', { item_id: 't_gambler' }, t)).s, 400, '중복 구매 금지');
    await call('POST', '/api/shop/buy', { item_id: 'f_glow' }, t);
    assert.equal(await pts(), 100, '700 - 600');
    assert.equal((await call('POST', '/api/shop/buy', { item_id: 'b_dice' }, t)).s, 400, '잔액 100 < 150');
    const me = (await call('GET', '/api/me', null, t)).j;
    assert.equal(me.title, '도박꾼'); assert.equal(me.fx, 'glow');
    // 채팅/랭킹에도 꾸밈 반영
    await call('POST', '/api/chat', { text: 'hi' }, t);
    assert.equal((await call('GET', '/api/chat', null, t)).j[0].title, '도박꾼');
    assert.equal((await call('GET', '/api/ranking')).j[0].fx, 'glow');
    // 해제/재장착
    await call('POST', '/api/shop/equip', { item_id: null, slot: 'title' }, t);
    assert.equal((await call('GET', '/api/me', null, t)).j.title, null);
    assert.equal((await call('POST', '/api/shop/equip', { item_id: 't_gambler' }, t)).s, 200);
    assert.equal((await call('GET', '/api/me', null, t)).j.title, '도박꾼');
    assert.equal((await call('POST', '/api/shop/equip', { item_id: null, slot: 'zzz' }, t)).s, 400);
    console.log('상점 테스트 통과');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();
});
