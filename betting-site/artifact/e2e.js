// 브라우저 시험 (개발용): 가짜 claude 로 두 사람이 같은 저장소를 보며 입장→도박→걸기→정산까지 한 번씩만 확인
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const { createStore } = require('./mockdb');
const store = createStore(), view = store.viewer();
const html = fs.readFileSync(path.join(__dirname, 'dobakjang.html'), 'utf8'), mock = fs.readFileSync(path.join(__dirname, 'mock-claude.js'), 'utf8');
const srv = http.createServer(async (req, res) => {
  if (req.url === '/__db') {
    let b = ''; req.on('data', (c) => b += c); req.on('end', async () => {
      const o = JSON.parse(b); let out = {};
      try {
        if (o.k === 'get') { const s = await view.doc(o.path).get(); out = { id: s.id, exists: s.exists, data: s.data() }; }
        else if (o.k === 'set') await view.doc(o.path).set(o.data); else if (o.k === 'update') await view.doc(o.path).update(o.data); else if (o.k === 'delete') await view.doc(o.path).delete();
        else if (o.k === 'acquire') out = await view.doc(o.path).acquire(o.o);
        else if (o.k === 'query') { let qq = view.collection(o.coll); o.filters.forEach(([f, op, v]) => { qq = qq.where(f, op, v); }); if (o.order) qq = qq.orderBy(o.order[0], o.order[1]); if (o.lim) qq = qq.limit(o.lim); const s = await qq.get(); out = { docs: s.docs.map((d) => ({ id: d.id, exists: true, data: d.data() })) }; }
      } catch (e) { out = { error: e.code || String(e) }; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(out));
    }); return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>' + mock + '</script></head><body>' + html + '</body></html>');
});
srv.listen(3140, async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }), errs = [];
  const open = async (uid, owner) => { const pg = await (await br.newContext({ viewport: { width: 420, height: 1600 }, deviceScaleFactor: 2 })).newPage(); pg.on('pageerror', (e) => errs.push(e.message)); pg.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); }); await pg.goto('http://localhost:3140/?uid=' + uid + (owner ? '&owner=1' : '')); return pg; };
  try {
    const A = await open('u_owner_aaaaaaaaaaaaaaaa', true), B = await open('u_friend_bbbbbbbbbbbbbbbb', false);
    for (const [pg, name] of [[A, '민수'], [B, '지은']]) { await pg.waitForSelector('#n', { timeout: 20000 }); await pg.fill('#n', name); await pg.click('button:has-text("입장하기")'); await pg.waitForSelector('text=카지노', { timeout: 20000 }); }
    console.log('입장:', (await A.textContent('#who')).replace(/\s+/g, ' ').trim().slice(0, 40), '|', (await B.textContent('#who')).replace(/\s+/g, ' ').trim().slice(0, 40));
    await A.click('button:has-text("➕ 만들기")'); await A.click('button:has-text("🎲 도박 만들기")').catch(() => {});
    await A.fill('#t', '점심 메뉴는?'); const opts = await A.$$('.o'); await opts[0].fill('한식'); await opts[1].fill('양식'); await A.click('button.pri:has-text("열기")');
    await B.waitForSelector('text=점심 메뉴는?', { timeout: 20000 });
    await B.fill('input[id^=a]', '100'); await B.click('button:has-text("걸기")'); await B.waitForFunction(() => document.querySelector('#who').textContent.includes('900'), null, { timeout: 20000 });
    console.log('B 걸고 난 뒤 칩:', (await B.textContent('#who')).replace(/\s+/g, ' ').trim());
    await A.waitForFunction(() => document.body.textContent.includes('총 100'), null, { timeout: 20000 }); console.log('A 화면에 총 100 반영');
    await A.screenshot({ path: process.env.SC + '/art_a.png' });
    await A.click('button:has-text("랭킹")'); await A.waitForSelector('table'); await A.screenshot({ path: process.env.SC + '/art_rank.png' }); await A.click('button:has-text("게임")');
    await A.click('button:has-text("취소(환불)")'); await A.waitForSelector('#modal:not([hidden]) .mmsg'); console.log('확인 창:', await A.textContent('.mmsg')); await A.click('#myes');
    await B.waitForFunction(() => document.querySelector('#who').textContent.includes('1,000'), null, { timeout: 20000 }); console.log('환불 뒤 B 칩:', (await B.textContent('#who')).replace(/\s+/g, ' ').trim());
    // 블록 블라스트: 시작 → 블록 하나 놓기 → 화면이 다시 그려져도 판이 유지 → 끝내기(점수 1234) → 보상 123
    await A.click('button:has-text("카지노")'); await A.click('button:has-text("🧱 블록 블라스트")'); await A.waitForSelector('.bbover.on button:has-text("게임 시작")', { timeout: 20000 });
    const chips0 = await A.evaluate(() => user.points);
    await A.click('.bbover.on button:has-text("게임 시작")'); await A.waitForSelector('.bbslot .bbpc', { timeout: 20000 });
    const slot = await A.$('.bbslot:nth-child(1) .bbpc'), sb = await slot.boundingBox(), bb = await (await A.$('.bbboard')).boundingBox();
    await A.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2); await A.mouse.down(); await A.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 8 }); await A.mouse.up(); await A.waitForTimeout(3800);
    console.log('블록 놓은 뒤 판 유지:', await A.evaluate(() => document.querySelectorAll('.bbc.f').length), '칸, 점수', await A.textContent('.bbscore'));
    await A.screenshot({ path: process.env.SC + '/art_bb.png' });
    await A.evaluate(() => { BB.score = () => 1234; bbFinish(); }); await A.waitForSelector('.bbover.on .bbbig', { timeout: 20000 });
    await A.waitForFunction((c) => user.points === c + 123, chips0, { timeout: 20000 }); console.log('보상 지급:', chips0, '→', await A.evaluate(() => user.points), '|', (await A.textContent('.bbcard')).replace(/\s+/g, ' '));
    await A.click('button:has-text("🎲 게임")');
    await A.click('button:has-text("⚙️ 관리")'); await A.waitForSelector('text=관리자 콘솔', { timeout: 20000 }); console.log('관리자 콘솔 열림:', (await A.textContent('.stats')).replace(/\s+/g, ' ').slice(0, 60));
    await A.screenshot({ path: process.env.SC + '/art_admin.png' });
    console.log('B 관리 버튼 없음:', (await B.$('button:has-text("⚙️ 관리")')) === null);
    console.log('오류:', errs);
  } catch (e) { console.error('실패:', e.message, errs); process.exitCode = 1; }
  await br.close(); srv.close();
});
