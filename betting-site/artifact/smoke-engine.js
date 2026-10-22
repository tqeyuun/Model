const assert = require('node:assert');
const { makeViewers } = require('./test-helpers');
(async () => {
  const { v } = await makeViewers(['A', 'B']);
  const dev = (n) => 'u' + n + 'abcdefghijklmnop';
  const enter = async (e, n, name) => (await e.call('', 'POST', '/api/enter', { room: 'dobak', name, pin: dev(n).slice(0, 16), dev: dev(n), mode: 'create', create: true }));
  const ra = await enter(v.A, 'A', '에이'); console.log(JSON.stringify(ra).slice(0, 120));
  const st = await v.A.call(ra.data.token, 'GET', '/api/state'); console.log(JSON.stringify(st).slice(0, 200));
})().catch((e) => { console.error(e); process.exit(1); });
