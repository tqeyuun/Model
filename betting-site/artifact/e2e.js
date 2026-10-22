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
    await A.click('button:has-text("🎲 게임")'); await A.click('button:has-text("🧱 블록 블라스트")'); await A.waitForSelector('.bbover.on button:has-text("게임 시작")', { timeout: 20000 });
    const chips0 = await A.evaluate(() => user.points);
    await A.click('.bbover.on button:has-text("게임 시작")'); await A.waitForSelector('.bbslot .bbpc', { timeout: 20000 });
    const slot = await A.$('.bbslot:nth-child(1) .bbpc'), sb = await slot.boundingBox(), bb = await (await A.$('.bbboard')).boundingBox();
    await A.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2); await A.mouse.down(); await A.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 8 }); await A.mouse.up(); await A.waitForTimeout(3800);
    console.log('블록 놓은 뒤 판 유지:', await A.evaluate(() => document.querySelectorAll('.bbc.f').length), '칸, 점수', await A.textContent('.bbscore'));
    await A.screenshot({ path: process.env.SC + '/art_bb.png' });
    await A.evaluate(() => { BB.score = () => 1234; bbFinish(); }); await A.waitForSelector('.bbover.on .bbbig', { timeout: 20000 });
    await A.waitForFunction((c) => user.points === c + 123, chips0, { timeout: 20000 }); console.log('보상 지급:', chips0, '→', await A.evaluate(() => user.points), '|', (await A.textContent('.bbcard')).replace(/\s+/g, ' '));
    await A.evaluate(() => BB.reset());   // 시험용 종료 흉내를 낸 뒤 판을 비움
    await A.click('button:has-text("🎲 게임")');
    // 블록 블라스트 대결: A 가 방을 열고 B 가 참가 → 같은 블록 순서 → 점수 제출 → 높은 쪽이 판돈 전부
    const chipsA0 = await A.evaluate(() => user.points), chipsB0 = await B.evaluate(() => user.points);
    await A.click('button:has-text("🧱 블록 블라스트")'); await A.waitForSelector('#bwstake', { timeout: 20000 });
    await A.fill('#bwstake', '100'); await A.fill('#bwcap', '2'); await A.click('button.pri:has-text("방 열기")');
    await B.click('button:has-text("🎲 게임")'); await B.click('button:has-text("🧱 블록 블라스트")'); await B.waitForSelector('button:has-text("참가 (")', { timeout: 20000 });
    await B.click('button:has-text("참가 (")'); await B.click('#myes'); await B.waitForSelector('button:has-text("내 판 시작")', { timeout: 20000 });
    await A.waitForSelector('button:has-text("내 판 시작")', { timeout: 20000 });
    await B.click('button:has-text("내 판 시작")'); await B.click('#myes'); await B.waitForFunction(() => BB.isRunning(), null, { timeout: 20000 });
    await A.click('button:has-text("내 판 시작")'); await A.click('#myes'); await A.waitForFunction(() => BB.isRunning(), null, { timeout: 20000 });
    const trayOf = (pg) => pg.evaluate(() => Array.from(document.querySelectorAll('.bbslot')).map((s) => s.innerHTML).join('|'));
    const sig = (pg) => pg.evaluate(() => Array.from(document.querySelectorAll('.bbslot')).map((s) => (s.querySelector('.bbpc') ? s.querySelector('.bbpc').style.gridTemplateColumns + '/' + s.querySelectorAll('i.f').length + '/' + (s.querySelector('i.f') ? s.querySelector('i.f').style.cssText.match(/--b\d/)[0] : '') : '-')).join(' '));
    console.log('트레이 A:', await sig(A), '| B:', await sig(B));
    console.log('대결 같은 블록 순서:', (await trayOf(A)) === (await trayOf(B)) && (await trayOf(A)).length > 100);
    await B.evaluate(() => { BB.score = () => 700; bbFinish(); });
    await B.waitForSelector('.bbover.on:has-text("제출 완료")', { timeout: 20000 }).catch(async (e) => { console.log('B 카드:', (await B.textContent('.bbcard')).replace(/\s+/g, ' ')); throw e; });
    await A.evaluate(() => { BB.score = () => 300; bbFinish(); }); await A.waitForSelector('.bbover.on:has-text("제출 완료")', { timeout: 20000 });
    await B.waitForFunction((c) => user.points === c + 100, chipsB0 - 0, { timeout: 25000 }).catch(() => {});
    await A.waitForFunction((c) => user.points === c - 100, chipsA0, { timeout: 25000 }).catch(() => {});
    console.log('대결 결과 칩:', 'A', chipsA0, '→', await A.evaluate(() => user.points), '| B', chipsB0, '→', await B.evaluate(() => user.points), '(기대 A -100, B +100)');
    await A.screenshot({ path: process.env.SC + '/art_bbwar.png', fullPage: true });
    // 남은 🪙 글자(칩 이미지로 안 바뀐 곳) 검사: 여러 화면을 돌며 글자와 속성에서 찾음
    const scan = (pg) => pg.evaluate(() => { const bad = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes('🪙') && !/^(SCRIPT|STYLE)$/.test(n.parentNode.nodeName)) bad.push('text:' + n.nodeValue.trim().slice(0, 40)); document.querySelectorAll('*').forEach((e) => { for (const a of e.attributes) if (a.value.includes('🪙')) bad.push(a.name + ':' + a.value.slice(0, 40)); }); return bad; });
    const leftovers = [];
    for (const tabName of ['🎲 게임', '➕ 만들기', '🎰 카지노', '💸 나눔', '🛍 상점', '랭킹']) { await A.click('button:has-text("' + tabName + '")'); await A.waitForTimeout(300); leftovers.push(...await scan(A)); }
    await A.click('button:has-text("💸 나눔")'); await A.click('button:has-text("🙏 구걸하기")'); await A.waitForTimeout(300); leftovers.push(...await scan(A));
    await A.click('button:has-text("🎲 게임")'); await A.click('button:has-text("🧱 블록 블라스트")'); await A.waitForTimeout(300); leftovers.push(...await scan(A));
    console.log('남은 🪙 글자:', JSON.stringify(leftovers));
    console.log('소유자에게도 관리 버튼 없음:', (await A.$('button:has-text("⚙️ 관리")')) === null);
    console.log('B 관리 버튼 없음:', (await B.$('button:has-text("⚙️ 관리")')) === null);
    console.log('오류:', errs);
  } catch (e) { console.error('실패:', e.message, errs); process.exitCode = 1; }
  await br.close(); srv.close();
});
