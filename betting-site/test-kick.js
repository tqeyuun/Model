// 추방 (Node 서버 + 구글 앱스 스크립트). 승인제는 꺼 두고 멤버 추방만 검증
process.env.DB_FILE = ':memory:';
process.env.APPROVAL = '0';
const assert = require('node:assert');
const vm = require('node:vm');
const { makeSandbox } = require('./gas-mock');
const { server, db } = require('./server');
const { sb } = makeSandbox();
const D1 = 'aaaaaaaaaaaa1111', D2 = 'bbbbbbbbbbbb2222', D3 = 'cccccccccccc3333';

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const call = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json() }; };
  const enter = async (room, name, dev, extra = {}) => call('POST', '/api/enter', { room, name, pin: '1234', dev, create: true, ...extra });
  const me = async (t) => (await call('GET', '/api/me', null, t)).j;
  try {
    const A = (await enter('kickroom', '방장', D1, { mode: 'create' })).j.token;
    const B = (await enter('kickroom', '비이', D2)).j.token, C = (await enter('kickroom', '씨이', D3)).j.token;
    assert.equal((await me(A)).is_owner, true); assert.equal((await me(B)).is_owner, false);
    const rk = (await call('GET', '/api/ranking', null, A)).j, idOf = (n) => rk.find((r) => r.name === n).id;
    assert.equal((await call('POST', '/api/kick', { user_id: idOf('씨이') }, B)).s, 404, '방장이 아니면 못 함');
    assert.equal((await call('POST', '/api/kick', { user_id: idOf('방장') }, A)).s, 400, '자신은 못 함');
    const X = (await enter('kickother', '남', 'dddddddddddd4444', { mode: 'create' })).j.token;
    assert.equal((await call('POST', '/api/kick', { user_id: idOf('씨이') }, X)).s, 404, '다른 방 방장은 못 함');
    // 진행 중인 도박에 걸려 있으면 거부
    await call('POST', '/api/bets', { title: '추방 시험', options: ['가', '나'] }, A);
    const opt = (await call('GET', '/api/bets', null, A)).j[0].options[0].id;
    assert.equal((await call('POST', '/api/wager', { option_id: opt, amount: 50 }, B)).s, 200);
    assert.equal((await call('POST', '/api/kick', { user_id: idOf('비이') }, A)).s, 400, '진행 중인 도박에 건 돈이 있으면 거부');
    // 정상 추방 + 진행 중인 뿌리기는 닫힘
    const drop = (await call('POST', '/api/drop/create', { total: 30, cnt: 2 }, C)).j;
    assert.equal((await call('POST', '/api/kick', { user_id: idOf('씨이') }, A)).s, 200);
    assert.equal((await call('GET', '/api/me', null, C)).s, 401, '추방된 계정은 로그인이 끊김');
    assert.equal(db.prepare('SELECT status FROM drops WHERE id=?').get(drop.id).status, 'cancelled');
    assert.equal((await call('GET', '/api/ranking', null, A)).j.length, 2);
    // 추방된 기기는 한동안 못 들어옴, 다른 기기는 가능, 시간이 지나면 가능
    assert.equal((await enter('kickroom', '씨이', D3)).s, 403);
    assert.equal((await call('POST', '/api/enter', { room: 'kickroom', name: '새닉', pin: '1234', dev: D3 })).s, 403, '확인 단계에서도 거부');
    assert.equal((await enter('kickroom', '씨이', 'eeeeeeeeeeee5555')).s, 200);
    db.prepare('UPDATE bans SET at=?').run(Date.now() - 25 * 3600e3);
    assert.equal((await enter('kickroom', '씨이2', D3)).s, 200);
    console.log('추방 테스트 통과 (Node)');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();

  try {
    const g = (t, m, u, b) => { vm.runInContext('TBL = {}; HOLDING = false;', sb); return JSON.parse(sb.handle(t || '', '', m, u, b)); };
    const ok = (r) => { assert.ok(!r.error, JSON.stringify(r)); return r.data; };
    const code = (r) => (r.error ? r.code : 200);
    const genter = (room, name, dev, extra = {}) => g('', 'POST', '/api/enter', { room, name, pin: '1234', dev, create: true, ...extra });
    const st = (t) => ok(g(t, 'GET', '/api/state'));
    const A = ok(genter('gkick', '방장', D1, { mode: 'create' })).token, B = ok(genter('gkick', '비이', D2)).token, C = ok(genter('gkick', '씨이', D3)).token;
    assert.equal(st(A).me.is_owner, true); assert.equal(st(B).me.is_owner, false);
    const rk = st(A).ranking, idOf = (n) => rk.find((r) => r.name === n).id;
    assert.equal(code(g(B, 'POST', '/api/kick', { user_id: idOf('씨이') })), 404);
    assert.equal(code(g(A, 'POST', '/api/kick', { user_id: idOf('방장') })), 400);
    const X = ok(genter('gkickother', '남', 'dddddddddddd4444', { mode: 'create' })).token;
    assert.equal(code(g(X, 'POST', '/api/kick', { user_id: idOf('씨이') })), 404);
    ok(g(A, 'POST', '/api/bets', { title: '추방 시험', options: ['가', '나'] }));
    ok(g(B, 'POST', '/api/wager', { option_id: st(A).bets[0].options[0].id, amount: 50 }));
    assert.equal(code(g(A, 'POST', '/api/kick', { user_id: idOf('비이') })), 400);
    const drop = ok(g(C, 'POST', '/api/drop/create', { total: 30, cnt: 2 }));
    assert.equal(code(g(A, 'POST', '/api/kick', { user_id: idOf('씨이') })), 200);
    assert.equal(code(g(C, 'GET', '/api/state')), 401);
    vm.runInContext('TBL = {};', sb); assert.equal(vm.runInContext(`tbl('drops').find(function (r) { return r.id === ${drop.id}; }).status`, sb), 'cancelled');
    assert.equal(st(A).ranking.length, 2);
    assert.equal(code(genter('gkick', '씨이', D3)), 403);
    assert.equal(code(g('', 'POST', '/api/enter', { room: 'gkick', name: '새닉', pin: '1234', dev: D3 })), 403);
    assert.equal(code(genter('gkick', '씨이', 'eeeeeeeeeeee5555')), 200);
    vm.runInContext("tbl('bans').all().forEach(function (b) { b.at = Date.now() - 25 * 3600e3; tbl('bans').save(b); });", sb);
    assert.equal(code(genter('gkick', '씨이2', D3)), 200);
    console.log('추방 테스트 통과 (GAS)');
  } catch (e) { console.error(e); process.exitCode = 1; }
});
