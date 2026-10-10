// 가입 승인제 (Node 서버 + 구글 앱스 스크립트)
process.env.DB_FILE = ':memory:';
process.env.APPROVAL = '1';
const assert = require('node:assert');
const vm = require('node:vm');
const { makeSandbox } = require('./gas-mock');
const { server, ADMIN_KEY } = require('./server');
const { sb } = makeSandbox();

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const call = async (m, p, b, t, admin) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(admin ? { 'x-admin-key': ADMIN_KEY } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json() }; };
  const enter = async (room, name, extra = {}) => (await call('POST', '/api/enter', { room, name, pin: '1234', create: true, ...extra })).j.token;
  const me = async (t) => (await call('GET', '/api/me', null, t)).j;
  try {
    const A = await enter('apprv', '방장', { mode: 'create' });
    let m = await me(A); assert.equal(m.pending, false); assert.equal(m.points, 1000, '방장은 자동 승인');
    const B = await enter('apprv', '신입');
    m = await me(B); assert.equal(m.pending, true); assert.equal(m.points, 0); assert.equal(m.can_aid, false);
    assert.deepEqual((await call('GET', '/api/bets', null, B)).j, []);
    assert.deepEqual((await call('GET', '/api/ranking', null, B)).j, []);
    for (const [method, p, b] of [['POST', '/api/bets', { title: 'x', options: ['a', 'b'] }], ['POST', '/api/aid', {}], ['GET', '/api/lun'], ['POST', '/api/drop/create', { total: 10, cnt: 2 }], ['POST', '/api/approve', { user_id: 1, accept: true }]])
      assert.equal((await call(method, p, b, B)).s, 403, p);
    assert.equal((await call('GET', '/api/ranking', null, A)).j.length, 1, '승인 전 계정은 랭킹에 안 보임');
    m = await me(A); assert.equal(m.group_size, 1); assert.deepEqual(m.pending_list.map((x) => x.name), ['신입']);
    const bid = m.pending_list[0].id;
    const X = await enter('other1', '남', { mode: 'create' });
    assert.equal((await call('POST', '/api/approve', { user_id: bid, accept: true }, X)).s, 404, '다른 방 방장은 못 함');
    assert.equal((await call('POST', '/api/approve', { user_id: bid, accept: true }, A)).s, 200);
    m = await me(B); assert.equal(m.pending, false); assert.equal(m.points, 1000);
    assert.equal((await call('GET', '/api/ranking', null, A)).j.length, 2); assert.equal((await me(A)).pending_list.length, 0);
    assert.equal((await call('POST', '/api/approve', { user_id: bid, accept: true }, A)).s, 404, '이미 승인됨');
    // 거절 → 계정 삭제, 닉네임 다시 사용 가능
    const D = await enter('apprv', '거절당함'); const did = (await me(A)).pending_list[0].id;
    assert.equal((await call('POST', '/api/approve', { user_id: did, accept: true }, B)).s, 404, '방장이 아니면 못 함');
    assert.equal((await call('POST', '/api/approve', { user_id: did, accept: false }, A)).s, 200);
    assert.equal((await call('GET', '/api/me', null, D)).s, 401, '삭제된 계정의 로그인은 끊김');
    const D2 = await enter('apprv', '거절당함'); assert.ok(D2);
    // 관리자 승인
    assert.equal((await call('POST', '/api/admin/user', { user_id: (await me(A)).pending_list[0].id, action: 'approve' }, null, true)).s, 200);
    assert.equal((await me(D2)).points, 1000);
    // 설정을 끄면 바로 입장
    assert.equal((await call('POST', '/api/admin/settings', { values: { approval_required: false } }, null, true)).s, 200);
    assert.equal((await me(await enter('apprv', '자유'))).pending, false);
    console.log('가입 승인제 테스트 통과 (Node)');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();

  /* ---- 구글 앱스 스크립트 ---- */
  try {
    const g = (t, m, u, b, key = '') => { vm.runInContext('TBL = {}; HOLDING = false;', sb); return JSON.parse(sb.handle(t || '', key, m, u, b)); };
    const ok = (r) => { assert.ok(!r.error, JSON.stringify(r)); return r.data; };
    const code = (r) => (r.error ? r.code : 200);
    const genter = (room, name, extra = {}) => ok(g('', 'POST', '/api/enter', { room, name, pin: '1234', create: true, ...extra })).token;
    const st = (t) => ok(g(t, 'GET', '/api/state'));
    const A = genter('gapprv', '방장', { mode: 'create' });
    assert.equal(st(A).me.pending, false); assert.equal(st(A).me.points, 1000);
    const B = genter('gapprv', '신입');
    let s = st(B); assert.equal(s.me.pending, true); assert.equal(s.me.points, 0); assert.deepEqual(s.bets, []); assert.deepEqual(s.ranking, []);
    for (const [m, p, b] of [['POST', '/api/bets', { title: 'x', options: ['a', 'b'] }], ['POST', '/api/aid', {}], ['GET', '/api/lun'], ['POST', '/api/drop/create', { total: 10, cnt: 2 }], ['POST', '/api/approve', { user_id: 1, accept: true }]])
      assert.equal(code(g(B, m, p, b)), 403, p);
    assert.equal(st(A).ranking.length, 1); assert.equal(st(A).me.group_size, 1);
    assert.deepEqual(st(A).me.pending_list.map((x) => x.name), ['신입']);
    const bid = st(A).me.pending_list[0].id;
    const X = genter('gother1', '남', { mode: 'create' });
    assert.equal(code(g(X, 'POST', '/api/approve', { user_id: bid, accept: true })), 404);
    assert.equal(code(g(A, 'POST', '/api/approve', { user_id: bid, accept: true })), 200);
    assert.equal(st(B).me.pending, false); assert.equal(st(B).me.points, 1000); assert.equal(st(A).ranking.length, 2);
    assert.equal(code(g(A, 'POST', '/api/approve', { user_id: bid, accept: true })), 404);
    const D = genter('gapprv', '거절당함'); const did = st(A).me.pending_list[0].id;
    assert.equal(code(g(B, 'POST', '/api/approve', { user_id: did, accept: true })), 404);
    assert.equal(code(g(A, 'POST', '/api/approve', { user_id: did, accept: false })), 200);
    assert.equal(code(g(D, 'GET', '/api/state')), 401);
    const D2 = genter('gapprv', '거절당함'); assert.ok(D2);
    vm.runInContext('TBL = {}; HOLDING = false;', sb); const KEY = sb.secret('ADMIN_KEY');
    assert.equal(code(g('', 'POST', '/api/admin/user', { user_id: st(A).me.pending_list[0].id, action: 'approve' }, KEY)), 200);
    assert.equal(st(D2).me.points, 1000);
    assert.equal(code(g('', 'POST', '/api/admin/settings', { values: { approval_required: false } }, KEY)), 200);
    assert.equal(st(genter('gapprv', '자유')).me.pending, false);
    console.log('가입 승인제 테스트 통과 (GAS)');
  } catch (e) { console.error(e); process.exitCode = 1; }
});
