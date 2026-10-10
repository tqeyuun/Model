// 한 기기에서 방마다 계정 1개 제한 (Node 서버 + 구글 앱스 스크립트)
process.env.DB_FILE = ':memory:';
const assert = require('node:assert');
const vm = require('node:vm');
const { makeSandbox } = require('./gas-mock');
const { server, db, applySettings } = require('./server');
const { sb } = makeSandbox();
const D1 = 'aaaaaaaaaaaa1111', D2 = 'bbbbbbbbbbbb2222';

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const call = async (p, b, t) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: JSON.stringify(b) }); return { s: r.status, j: await r.json() }; };
  try {
    const enter = (room, name, dev, extra = {}) => call('/api/enter', { room, name, pin: '1234', dev, create: true, ...extra });
    assert.equal((await enter('devroom', '에이', D1, { mode: 'create' })).s, 200, '방 만들기');
    assert.equal((await enter('devroom', '비이', D1)).s, 403, '같은 기기에서 두 번째 계정은 거부');
    assert.equal((await call('/api/enter', { room: 'devroom', name: '비이', pin: '1234', dev: D1 })).s, 403, '확인 단계에서도 미리 거부');
    assert.equal((await enter('devroom', '비이', D2)).s, 200, '다른 기기는 가능');
    assert.equal((await enter('devroom', '씨이', 'short')).s, 200, '기기 번호 형식이 틀리면 제한 없이 통과(우리 화면은 항상 올바른 값을 보냄)');
    assert.equal((await enter('other77', '에이', D1, { mode: 'create' })).s, 200, '다른 방은 따로');
    assert.equal((await call('/api/enter', { room: 'devroom', name: '에이', pin: '1234', dev: D1 })).s, 200, '기존 계정 로그인은 그대로');
    // 예전 계정(기기 없음)은 처음 로그인한 기기에 묶임
    db.prepare("UPDATE users SET dev=NULL WHERE name='비이'").run();
    assert.equal((await call('/api/enter', { room: 'devroom', name: '비이', pin: '1234', dev: D2 })).s, 200);
    assert.equal((await enter('devroom', '디이', D2)).s, 403);
    // 관리자 해제 / 설정 끄기
    const adminKey = require('./server').ADMIN_KEY, adm = async (p, b) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey }, body: JSON.stringify(b) })).status;
    const uid = db.prepare("SELECT id FROM users WHERE name='비이'").get().id;
    if (await adm('/api/admin/user', { user_id: uid, action: 'clear_device' }) === 200) assert.equal((await enter('devroom', '디이', D2)).s, 200, '기기 해제 뒤에는 가능');
    else console.log('(관리자 경로 확인 필요)');
    const off = await adm('/api/admin/settings', { values: { device_limit: false } });
    assert.equal(off, 200); assert.equal((await enter('devroom', '이이', D1)).s, 200, '제한을 끄면 가능');
    await adm('/api/admin/settings', { values: { device_limit: true } });
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();

  /* ---- 구글 앱스 스크립트 ---- */
  try {
    const gcall = (m, u, b, t) => { vm.runInContext('TBL = {}; HOLDING = false;', sb); return JSON.parse(sb.handle(t || '', '', m, u, b)); };
    const code = (r) => (r.error ? r.code : 200);
    const gen = (room, name, dev, extra = {}) => code(gcall('POST', '/api/enter', { room, name, pin: '1234', dev, create: true, ...extra }));
    assert.equal(gen('gdevroom', '에이', D1, { mode: 'create' }), 200);
    assert.equal(gen('gdevroom', '비이', D1), 403);
    assert.equal(code(gcall('POST', '/api/enter', { room: 'gdevroom', name: '비이', pin: '1234', dev: D1 })), 403);
    assert.equal(gen('gdevroom', '비이', D2), 200);
    assert.equal(gen('gother', '에이', D1, { mode: 'create' }), 200);
    assert.equal(code(gcall('POST', '/api/enter', { room: 'gdevroom', name: '에이', pin: '1234', dev: D1 })), 200);
    vm.runInContext("var u = tbl('users').find(function (x) { return x.name === '비이' && x.grp; }); u.dev = ''; tbl('users').save(u);", sb);
    assert.equal(code(gcall('POST', '/api/enter', { room: 'gdevroom', name: '비이', pin: '1234', dev: D2 })), 200);
    assert.equal(gen('gdevroom', '디이', D2), 403);
    vm.runInContext('CFG.DEVICE_LIMIT = false;', sb);
    assert.equal(gen('gdevroom', '디이', D2), 200, '제한을 끄면 가능');
    console.log('기기당 계정 제한 테스트 통과');
  } catch (e) { console.error(e); process.exitCode = 1; }
});
