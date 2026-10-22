const fs = require('node:fs'), path = require('node:path');
const { chromium } = require('/opt/node-tools/node_modules/playwright');
(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }), errs = [];
  const pg = await (await br.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, hasTouch: false })).newPage();
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await pg.setContent('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' + fs.readFileSync(path.join(__dirname, 'blockblast.html'), 'utf8') + '</body></html>');
  await pg.waitForSelector('#tray .pc');
  // 규칙: 가로줄/세로줄 판정과 점수
  const r = await pg.evaluate(() => {
    const B = window.__bb, empty = () => Array.from({ length: 8 }, () => Array(8).fill(-1));
    const b = empty(); for (let x = 0; x < 7; x++) b[7][x] = 1; for (let y = 0; y < 7; y++) b[y][7] = 2;          // 7행 앞 7칸, 7열 위 7칸이 차 있음
    const one = B.SHAPES.find((s) => s.cells.length === 1), fl = B.fullLines(b, one, 7, 7, 3);
    const b2 = empty(); b2[3][2] = 0; const fl2 = B.fullLines(b2, one, 0, 0, 3);
    return { rows: fl.rows, cols: fl.cols, none: [fl2.rows.length, fl2.cols.length], fit: [B.fits(empty(), one, 0, 0), B.fits(b, one, 7, 0), B.fits(empty(), one, 8, 0)],
      pts: [B.points(1, 0, 0), B.points(1, 2, 1), B.points(4, 1, 2), B.shapes === undefined], shapes: B.SHAPES.length };
  });
  console.log('규칙:', JSON.stringify(r));
  // 실제 끌어서 놓기: 첫 번째 블록을 판 가운데로
  const before = await pg.evaluate(() => window.__bb.state().board.flat().filter((v) => v >= 0).length);
  const slot = await pg.$('#tray .slot:nth-child(1) .pc'), sb = await slot.boundingBox(), bb = await (await pg.$('#board')).boundingBox();
  await pg.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2); await pg.mouse.down();
  await pg.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 8 });
  await pg.screenshot({ path: process.env.SC + '/bb_drag.png' });
  await pg.mouse.up(); await pg.waitForTimeout(500);
  const st = await pg.evaluate(() => { const s = window.__bb.state(); return { filled: s.board.flat().filter((v) => v >= 0).length, score: s.score, used: s.pieces.filter((p) => p.used).length }; });
  console.log('놓은 뒤:', JSON.stringify({ before, ...st }));
  await pg.screenshot({ path: process.env.SC + '/bb_after.png' });
  console.log('오류:', errs);
  await br.close();
})().catch((e) => { console.error(e); process.exit(1); });
// (이어서) 줄 지우기 한 번 확인
(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }), errs = [];
  const pg = await (await br.newContext({ viewport: { width: 400, height: 860 } })).newPage();
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body>' + fs.readFileSync(path.join(__dirname, 'blockblast.html'), 'utf8') + '</body></html>');
  await pg.waitForSelector('#tray .pc');
  await pg.evaluate(() => { const B = window.__bb, b = Array.from({ length: 8 }, () => Array(8).fill(-1)); for (let x = 0; x < 7; x++) b[7][x] = 1; B.state().pieces[0].shape = B.SHAPES[0]; B.setBoard(b); });
  const slot = await pg.$('#tray .slot:nth-child(1) .pc'), sb = await slot.boundingBox(), cells = await pg.$$('#board .c'), tb = await cells[63].boundingBox();
  await pg.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2); await pg.mouse.down(); await pg.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 8 }); await pg.mouse.up(); await pg.waitForTimeout(700);
  const st = await pg.evaluate(() => { const s = window.__bb.state(); return { row7: s.board[7].filter((v) => v >= 0).length, score: s.score }; });
  console.log('줄 지우기:', JSON.stringify(st), '(기대: row7 0칸, 점수 11)'); console.log('오류2:', errs);
  await br.close();
})();
