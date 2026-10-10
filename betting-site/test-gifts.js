// 돈뿌리기 / 구걸하기 서버 통합 테스트
process.env.DB_FILE = ':memory:';
const assert = require('node:assert');
const G = require('./games-core');
const { server, db } = require('./server');

// 분배 규칙: 어떤 난수가 나와도 합계가 정확히 맞고 모두 1 이상
for (const [total, cnt] of [[10, 10], [10, 2], [100, 3], [1000, 20], [37, 7], [20, 20]]) {
  for (const rnd of [() => 0, () => 0.999999, () => 0.5, Math.random, Math.random, Math.random]) {
    let left = total, sum = 0;
    for (let k = cnt; k >= 1; k--) {
      const v = G.dropShare(left, k, rnd);
      assert.ok(Number.isInteger(v) && v >= 1 && v <= left - (k - 1), `${total}/${cnt}: ${v}`);
      left -= v; sum += v;
    }
    assert.equal(left, 0); assert.equal(sum, total);
  }
}

server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const call = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json() }; };
  const mk = async (n, pin = '1111') => (await call('POST', '/api/signup', { name: n, pin })).j.token;
  const pts = async (t) => (await call('GET', '/api/me', null, t)).j.points;
  const gifts = async (t) => (await call('GET', '/api/gifts', null, t)).j;
  try {
    const [a, b, c, d] = [await mk('에이'), await mk('비이'), await mk('씨이'), await mk('디이')];
    const x = await mk('엑스', '9999');   // 다른 방
    const total = async () => (await Promise.all([a, b, c, d, x].map(pts))).reduce((p, q) => p + q);
    assert.equal(await total(), 5000);
    assert.equal((await call('GET', '/api/gifts')).s, 401);

    /* ===== 💸 돈뿌리기 ===== */
    for (const bad of [{ total: 5, cnt: 3 }, { total: 5000, cnt: 3 }, { total: 100, cnt: 1 }, { total: 100, cnt: 21 }, { total: 10.5, cnt: 2 }, { total: 100, cnt: 2.5 }, { total: 10, cnt: 11 }, {}])
      assert.equal((await call('POST', '/api/drop/create', bad, a)).s, 400, JSON.stringify(bad));
    assert.equal(await pts(a), 1000);
    const d1 = (await call('POST', '/api/drop/create', { total: 100, cnt: 3 }, a)).j;
    assert.equal(await pts(a), 900, '뿌린 돈은 즉시 차감');
    assert.equal((await call('POST', '/api/drop/create', { total: 100, cnt: 3 }, a)).s, 409, '연타 방지');
    let g = await gifts(b);
    assert.equal(g.drops.length, 1); assert.equal(g.drops[0].left_amt, null, '남은 금액은 뿌린 사람에게만 보임'); assert.equal(g.drops[0].mine, false);
    assert.equal((await gifts(a)).drops[0].left_amt, 100);
    assert.equal((await gifts(x)).drops.length, 0, '다른 방에는 안 보임');
    assert.equal((await call('POST', '/api/drop/claim', { id: d1.id }, x)).s, 404);
    assert.equal((await call('POST', '/api/drop/claim', { id: d1.id }, a)).s, 400, '자기가 뿌린 건 못 받음');
    const got = [];
    for (const t of [b, c]) { const r = await call('POST', '/api/drop/claim', { id: d1.id }, t); assert.equal(r.s, 200); got.push(r.j.amount); assert.equal((await call('POST', '/api/drop/claim', { id: d1.id }, t)).s, 400, '두 번 못 받음'); }
    assert.equal((await gifts(d)).drops[0].left_cnt, 1);
    const r3 = await call('POST', '/api/drop/claim', { id: d1.id }, d); got.push(r3.j.amount);
    assert.equal(got.reduce((p, q) => p + q), 100, '합계가 정확히 뿌린 금액');
    assert.ok(got.every((v) => v >= 1));
    assert.equal((await gifts(a)).drops.length, 0); assert.equal((await gifts(a)).drops_recent.length, 1);
    assert.equal((await call('POST', '/api/drop/claim', { id: d1.id }, d)).s, 400, '끝난 건 못 받음');
    assert.equal(await total(), 5000);

    // 닫기: 남은 금액 회수
    const d2 = (await call('POST', '/api/drop/create', { total: 50, cnt: 5 }, a)).j;
    const c2 = (await call('POST', '/api/drop/claim', { id: d2.id }, b)).j.amount;
    assert.equal((await call('POST', '/api/drop/cancel', { id: d2.id }, b)).s, 403, '뿌린 사람만 닫을 수 있음');
    assert.equal((await call('POST', '/api/drop/cancel', { id: d2.id }, a)).j.refund, 50 - c2);
    assert.equal((await call('POST', '/api/drop/claim', { id: d2.id }, c)).s, 400, '닫힌 건 못 받음');
    assert.equal(await total(), 5000);

    // 12시간 지나면 자동 회수
    const d3 = (await call('POST', '/api/drop/create', { total: 40, cnt: 2 }, a)).j, before = await pts(a);
    db.prepare('UPDATE drops SET created_at=? WHERE id=?').run(Date.now() - 13 * 3600e3, d3.id);
    await gifts(b);
    assert.equal(await pts(a), before + 40); assert.equal((await call('POST', '/api/drop/claim', { id: d3.id }, b)).s, 400);
    assert.equal(await total(), 5000);

    // 동시에 3개까지
    for (const t of [10, 20, 30]) assert.equal((await call('POST', '/api/drop/create', { total: t, cnt: 2 }, a)).s, 200);
    assert.equal((await call('POST', '/api/drop/create', { total: 40, cnt: 2 }, a)).s, 400);

    /* ===== 🙏 구걸하기 ===== */
    for (const bad of [{ want: 5 }, { want: 5000 }, { want: 100.5 }, {}]) assert.equal((await call('POST', '/api/beg/create', bad, b)).s, 400, JSON.stringify(bad));
    const bg = (await call('POST', '/api/beg/create', { want: 200, msg: '  밥값 좀  ' }, b)).j;
    assert.equal((await call('POST', '/api/beg/create', { want: 200 }, b)).s, 409, '연타 방지');
    let bv = (await gifts(c)).begs[0];
    assert.equal(bv.msg, '밥값 좀'); assert.equal(bv.want, 200); assert.equal(bv.mine, false);
    assert.equal((await gifts(x)).begs.length, 0, '다른 방에는 안 보임');
    for (const [t, amount, s] of [[b, 10, 400], [c, 0, 400], [c, -5, 400], [c, 1.5, 400], [c, 201, 400], [x, 10, 404]])
      assert.equal((await call('POST', '/api/beg/give', { id: bg.id, amount }, t)).s, s, `give ${amount}`);
    const pb = await pts(b), pc = await pts(c);
    assert.equal((await call('POST', '/api/beg/give', { id: bg.id, amount: 50 }, c)).s, 200);
    assert.equal(await pts(b), pb + 50); assert.equal(await pts(c), pc - 50);
    assert.equal((await call('POST', '/api/beg/give', { id: bg.id, amount: 151 }, d)).s, 400, '남은 필요 금액보다 많이 못 줌');
    assert.equal((await call('POST', '/api/beg/give', { id: bg.id, amount: 150 }, d)).s, 200);
    bv = (await gifts(b)).begs; assert.equal(bv.length, 0);
    const rec = (await gifts(b)).begs_recent[0];
    assert.equal(rec.got, 200); assert.equal(rec.donors.length, 2); assert.equal(rec.status, 'done');
    assert.equal((await call('POST', '/api/beg/give', { id: bg.id, amount: 1 }, c)).s, 400, '달성한 건 더 못 줌');
    assert.equal(await total(), 5000 - 60, "뿌리는 중인 60은 맡겨진 상태");

    // 가난해서 못 주는 경우 / 닫기 / 만료
    const bg2 = (await call('POST', '/api/beg/create', { want: 100 }, b)).j;
    db.prepare('UPDATE users SET points=30 WHERE id=(SELECT id FROM users WHERE name=?)').run('씨이');
    assert.equal((await call('POST', '/api/beg/give', { id: bg2.id, amount: 31 }, c)).s, 400, '가진 돈보다 많이 못 줌');
    assert.equal((await call('POST', '/api/beg/cancel', { id: bg2.id }, c)).s, 403);
    assert.equal((await call('POST', '/api/beg/cancel', { id: bg2.id }, b)).s, 200);
    assert.equal((await call('POST', '/api/beg/give', { id: bg2.id, amount: 10 }, c)).s, 400, '닫힌 건 못 줌');
    const bg3 = (await call('POST', '/api/beg/create', { want: 100 }, b)).j;
    db.prepare('UPDATE begs SET created_at=? WHERE id=?').run(Date.now() - 13 * 3600e3, bg3.id);
    assert.equal((await gifts(c)).begs.length, 0); assert.equal((await call('POST', '/api/beg/give', { id: bg3.id, amount: 10 }, c)).s, 400, '만료된 건 못 줌');
    assert.equal((await call('POST', '/api/beg/create', { want: 100 }, b)).s, 200, '닫힌 뒤에는 다시 올릴 수 있음');

    console.log('돈뿌리기·구걸 테스트 통과');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();
});
