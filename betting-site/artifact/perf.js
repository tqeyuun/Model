// 화면 속도 측정 (개발용): 데이터가 많을 때 다시 그리기·새로고침이 얼마나 걸리는지 브라우저에서 잼
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const { createStore } = require('./mockdb');
const store = createStore(), view = store.viewer();
const html = fs.readFileSync(path.join(__dirname, 'dobakjang.html'), 'utf8'), mock = fs.readFileSync(path.join(__dirname, 'mock-claude.js'), 'utf8');
const UID = 'u_perf_viewer_0000000000', DEV = ('uperfviewer0000000000').padEnd(16, '0');
async function seed() {
  const U = +process.env.U || 12, B = +process.env.B || 400, W = +process.env.W || 5000, M = +process.env.M || 400, now = Date.now(), put = (c, id, d) => view.doc(c + '/' + id).set(d), ps = [];
  ps.push(put('rooms', 1, { id: 1, grp: 'g_dobak', code: 'dobak', created_at: now }));
  for (let i = 1; i <= U; i++) ps.push(put('users', i, { id: i, name: '유저' + i, salt: 's', hash: 'h:x', points: 1000 + i * 37, last_aid: 0, created_at: now, grp: 'g_dobak', dev: i === 1 ? DEV : 'dev' + String(i).padStart(14, '0'), approved: 1 }));
  let oid = 0;
  for (let b = 1; b <= B; b++) { const open = b > B - 5; ps.push(put('bets', b, { id: b, title: '도박 ' + b, creator_id: 1 + (b % U), status: open ? 'open' : 'resolved', winner: open ? '' : (b - 1) * 3 + 1, closes_at: '', created_at: now - (B - b) * 60000 })); for (let o = 0; o < 3; o++) ps.push(put('options', ++oid, { id: oid, bet_id: b, label: '선택지' + o })); }
  for (let w = 1; w <= W; w++) { const b = 1 + (w % B); ps.push(put('wagers', w, { id: w, bet_id: b, option_id: (b - 1) * 3 + 1 + (w % 3), user_id: 1 + (w % U), amount: 10 + (w % 9) * 10, payout: w % 2 ? 30 : 0, lucky: 0, created_at: now - w * 1000 })); }
  for (let m = 1; m <= M; m++) ps.push(put('messages', now * 1000 + m, { id: now * 1000 + m, user_id: 1 + (m % U), text: '메시지 ' + m, created_at: now - (M - m) * 1000, bet_id: 1 + (m % B) }));
  await Promise.all(ps);
  // 1번 유저의 PIN 해시를 로그인 방식에 맞춤
  await view.doc('users/1').update({ hash: 'h:' + DEV.slice(0, 16) + ':s' });
}
const srv = http.createServer(async (req, res) => {
  if (req.url === '/__db') { let b = ''; req.on('data', (c) => b += c); req.on('end', async () => { const o = JSON.parse(b); let out = {}; try {
    if (o.k === 'get') { const s = await view.doc(o.path).get(); out = { id: s.id, exists: s.exists, data: s.data() }; } else if (o.k === 'set') await view.doc(o.path).set(o.data); else if (o.k === 'update') await view.doc(o.path).update(o.data); else if (o.k === 'delete') await view.doc(o.path).delete();
    else if (o.k === 'acquire') out = await view.doc(o.path).acquire(o.o);
    else if (o.k === 'query') { let q = view.collection(o.coll); o.filters.forEach(([f, op, v]) => { q = q.where(f, op, v); }); if (o.order) q = q.orderBy(o.order[0], o.order[1]); if (o.lim) q = q.limit(o.lim); const s = await q.get(); out = { docs: s.docs.map((d) => ({ id: d.id, exists: true, data: d.data() })) }; } } catch (e) { out = { error: String(e.code || e) }; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(out)); }); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>' + mock + '</script></head><body>' + html + '</body></html>');
});
srv.listen(3150, async () => {
  await seed();
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }), errs = [];
  const pg = await (await br.newContext({ viewport: { width: 420, height: 900 } })).newPage(); pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto('http://localhost:3150/?uid=' + UID);
  const t0 = Date.now(); await pg.waitForSelector('text=카지노', { timeout: 60000 }); console.log('입장까지', Date.now() - t0, 'ms');
  const meas = async (label, fn, n = 5) => { const r = await pg.evaluate(async ([src, n]) => { const f = eval('(' + src + ')'); const t = []; for (let i = 0; i < n; i++) { const s = performance.now(); await f(); t.push(performance.now() - s); } t.sort((a, b) => a - b); return { med: t[Math.floor(n / 2)], nodes: document.querySelectorAll('*').length, htmlKB: Math.round(document.getElementById('app').innerHTML.length / 1024) }; }, [fn.toString(), n]); console.log(label.padEnd(26), r.med.toFixed(1).padStart(7), 'ms | DOM', r.nodes, '개 | HTML', r.htmlKB, 'KB'); };
  await pg.evaluate(() => { listMode = 'bets'; });
  await meas('render (도박 목록)', () => render());
  await meas('refresh (도박 목록)', () => refresh());
  await pg.evaluate(() => { listMode = 'all'; });
  await meas('render (전체)', () => render());
  await meas('refresh (전체)', () => refresh());
  await pg.evaluate(() => { tab = 'rank'; });
  await meas('render (랭킹)', () => render());
  await pg.evaluate(() => { tab = 'bets'; listMode = 'all'; });
  console.log('오류:', errs); await br.close(); srv.close();
});
