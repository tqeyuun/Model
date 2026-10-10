// 닉네임 변경은 닫혀 있음 (나중에 상점 상품). 관리자가 열면 가능
process.env.DB_FILE = ':memory:';
process.env.APPROVAL = '0'; process.env.RENAME_OPEN = '0';
const assert = require('node:assert');
const vm = require('node:vm');
const { makeSandbox } = require('./gas-mock');
const { server, ADMIN_KEY } = require('./server');
const { sb } = makeSandbox();

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const call = async (m, p, b, t, admin) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(admin ? { 'x-admin-key': ADMIN_KEY } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json() }; };
  try {
    const t = (await call('POST', '/api/signup', { name: '에이', pin: '1234' })).j.token;
    assert.equal((await call('GET', '/api/me', null, t)).j.can_rename, false);
    assert.equal((await call('POST', '/api/nickname', { name: '새이름' }, t)).s, 403);
    assert.equal((await call('POST', '/api/admin/settings', { values: { rename_open: true } }, null, true)).s, 200);
    assert.equal((await call('GET', '/api/me', null, t)).j.can_rename, true);
    assert.equal((await call('POST', '/api/nickname', { name: '새이름' }, t)).s, 200);
    console.log('닉네임 변경 닫힘 테스트 통과 (Node)');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();
  try {
    vm.runInContext('CFG.RENAME_OPEN = false;', sb);
    const g = (tk, m, u, b, key = '') => { vm.runInContext('TBL = {}; HOLDING = false;', sb); return JSON.parse(sb.handle(tk || '', key, m, u, b)); };
    const t = g('', 'POST', '/api/signup', { name: '에이', pin: '1234' }).data.token;
    assert.equal(g(t, 'GET', '/api/state').data.me.can_rename, false);
    assert.equal(g(t, 'POST', '/api/nickname', { name: '새이름' }).code, 403);
    vm.runInContext('TBL = {}; HOLDING = false;', sb); const KEY = sb.secret('ADMIN_KEY');
    assert.ok(!g('', 'POST', '/api/admin/settings', { values: { rename_open: true } }, KEY).error);
    assert.equal(g(t, 'GET', '/api/state').data.me.can_rename, true);
    assert.ok(!g(t, 'POST', '/api/nickname', { name: '새이름' }).error);
    console.log('닉네임 변경 닫힘 테스트 통과 (GAS)');
  } catch (e) { console.error(e); process.exitCode = 1; }
});
