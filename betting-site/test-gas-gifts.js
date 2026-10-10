// Code.gs + Games.gs: 돈뿌리기 / 구걸하기 (Node 버전과 같은 시나리오)
const vm = require('node:vm');
const assert = require('node:assert');
const { makeSandbox } = require('./gas-mock');
const { sb } = makeSandbox();
const call = (token, method, url, body) => { vm.runInContext('TBL = {}; HOLDING = false;', sb); return JSON.parse(sb.handle(token, '', method, url, body)); };
const ok = (r) => { assert.ok(!r.error, JSON.stringify(r)); return r.data; };
const code = (r) => (r.error ? r.code : 200);
const mk = (name, pin = '1111') => ok(call('', 'POST', '/api/signup', { name, pin })).token;
const pts = (t) => ok(call(t, 'GET', '/api/state')).me.points;
const gifts = (t) => ok(call(t, 'GET', '/api/gifts'));
const old = (table, id) => vm.runInContext(`var o = tbl('${table}').find(function(r){return r.id===${id}}); o.created_at = Date.now() - 13*3600e3; tbl('${table}').save(o);`, sb);

const [a, b, c, d] = ['에이', '비이', '씨이', '디이'].map((n) => mk(n));
const x = mk('엑스', '9999');
const total = () => [a, b, c, d, x].map(pts).reduce((p, q) => p + q);
assert.equal(total(), 5000);
assert.equal(code(call('', 'GET', '/api/gifts')), 401);

/* ===== 💸 돈뿌리기 ===== */
for (const bad of [{ total: 5, cnt: 3 }, { total: 5000, cnt: 3 }, { total: 100, cnt: 1 }, { total: 100, cnt: 21 }, { total: 10.5, cnt: 2 }, { total: 100, cnt: 2.5 }, { total: 10, cnt: 11 }, {}])
  assert.equal(code(call(a, 'POST', '/api/drop/create', bad)), 400, JSON.stringify(bad));
const d1 = ok(call(a, 'POST', '/api/drop/create', { total: 100, cnt: 3 }));
assert.equal(pts(a), 900);
assert.equal(code(call(a, 'POST', '/api/drop/create', { total: 100, cnt: 3 })), 409);
assert.equal(gifts(b).drops.length, 1); assert.equal(gifts(b).drops[0].left_amt, null); assert.equal(gifts(a).drops[0].left_amt, 100);
assert.equal(gifts(x).drops.length, 0);
assert.equal(code(call(x, 'POST', '/api/drop/claim', { id: d1.id })), 404);
assert.equal(code(call(a, 'POST', '/api/drop/claim', { id: d1.id })), 400);
const got = [];
for (const t of [b, c, d]) { const r = call(t, 'POST', '/api/drop/claim', { id: d1.id }); got.push(ok(r).amount); assert.equal(code(call(t, 'POST', '/api/drop/claim', { id: d1.id })), 400); }
assert.equal(got.reduce((p, q) => p + q), 100); assert.ok(got.every((v) => v >= 1));
assert.equal(gifts(a).drops.length, 0); assert.equal(gifts(a).drops_recent.length, 1);
assert.equal(total(), 5000);

const d2 = ok(call(a, 'POST', '/api/drop/create', { total: 50, cnt: 5 }));
const c2 = ok(call(b, 'POST', '/api/drop/claim', { id: d2.id })).amount;
assert.equal(code(call(b, 'POST', '/api/drop/cancel', { id: d2.id })), 403);
assert.equal(ok(call(a, 'POST', '/api/drop/cancel', { id: d2.id })).refund, 50 - c2);
assert.equal(code(call(c, 'POST', '/api/drop/claim', { id: d2.id })), 400);
assert.equal(total(), 5000);

const d3 = ok(call(a, 'POST', '/api/drop/create', { total: 40, cnt: 2 })), before = pts(a);
old('drops', d3.id); gifts(b);
assert.equal(pts(a), before + 40); assert.equal(code(call(b, 'POST', '/api/drop/claim', { id: d3.id })), 400);
assert.equal(total(), 5000);

for (const t of [10, 20, 30]) assert.equal(code(call(a, 'POST', '/api/drop/create', { total: t, cnt: 2 })), 200);
assert.equal(code(call(a, 'POST', '/api/drop/create', { total: 40, cnt: 2 })), 400);

/* ===== 🙏 구걸하기 ===== */
for (const bad of [{ want: 5 }, { want: 5000 }, { want: 100.5 }, {}]) assert.equal(code(call(b, 'POST', '/api/beg/create', bad)), 400, JSON.stringify(bad));
const bg = ok(call(b, 'POST', '/api/beg/create', { want: 200, msg: '  밥값 좀  ' }));
assert.equal(code(call(b, 'POST', '/api/beg/create', { want: 200 })), 409);
const bv = gifts(c).begs[0];
assert.equal(bv.msg, '밥값 좀'); assert.equal(bv.want, 200); assert.equal(bv.mine, false);
assert.equal(gifts(x).begs.length, 0);
for (const [t, amount, s] of [[b, 10, 400], [c, 0, 400], [c, -5, 400], [c, 1.5, 400], [c, 201, 400], [x, 10, 404]])
  assert.equal(code(call(t, 'POST', '/api/beg/give', { id: bg.id, amount })), s, `give ${amount}`);
const pb = pts(b), pc = pts(c);
ok(call(c, 'POST', '/api/beg/give', { id: bg.id, amount: 50 }));
assert.equal(pts(b), pb + 50); assert.equal(pts(c), pc - 50);
assert.equal(code(call(d, 'POST', '/api/beg/give', { id: bg.id, amount: 151 })), 400);
ok(call(d, 'POST', '/api/beg/give', { id: bg.id, amount: 150 }));
assert.equal(gifts(b).begs.length, 0);
const rec = gifts(b).begs_recent[0];
assert.equal(rec.got, 200); assert.equal(rec.donors.length, 2); assert.equal(rec.status, 'done');
assert.equal(code(call(c, 'POST', '/api/beg/give', { id: bg.id, amount: 1 })), 400);
assert.equal(total(), 5000 - 60);

const bg2 = ok(call(b, 'POST', '/api/beg/create', { want: 100 }));
vm.runInContext("var u = tbl('users').find(function (x) { return x.name === '씨이'; }); u.points = 30; tbl('users').save(u);", sb);
assert.equal(code(call(c, 'POST', '/api/beg/give', { id: bg2.id, amount: 31 })), 400);
assert.equal(code(call(c, 'POST', '/api/beg/cancel', { id: bg2.id })), 403);
ok(call(b, 'POST', '/api/beg/cancel', { id: bg2.id }));
assert.equal(code(call(c, 'POST', '/api/beg/give', { id: bg2.id, amount: 10 })), 400);
const bg3 = ok(call(b, 'POST', '/api/beg/create', { want: 100 }));
old('begs', bg3.id);
assert.equal(gifts(c).begs.length, 0); assert.equal(code(call(c, 'POST', '/api/beg/give', { id: bg3.id, amount: 10 })), 400);
assert.equal(code(call(b, 'POST', '/api/beg/create', { want: 100 })), 200);

console.log('GAS 돈뿌리기·구걸 테스트 통과');
