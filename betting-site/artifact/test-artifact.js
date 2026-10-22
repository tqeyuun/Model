// 아티팩트 엔진 통합 테스트: 여러 사람이 같은 저장소를 동시에 쓰는 상황 (규칙 코드는 구글 스크립트 버전과 같은 것)
const assert = require('node:assert');
const { makeViewers } = require('./test-helpers');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { v, store } = await makeViewers(['A', 'B', 'C', 'D'], { latency: 12 });
  const names = { A: '에이', B: '비이', C: '씨이', D: '디이' }, tok = {};
  const ok = (r) => { assert.ok(!r.error, JSON.stringify(r)); return r.data; };
  const call = (n, m, u, b) => v[n].call(tok[n], m, u, b || {});
  const st = async (n) => ok(await call(n, 'GET', '/api/state'));
  const pts = async (n) => (await st(n)).me.points;
  const total = async () => (await Promise.all(Object.keys(v).map(pts))).reduce((a, b) => a + b);
  const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(30); } return false; };

  /* ---- 입장 ---- */
  tok.A = ok(await v.A.enter(names.A)).token;
  assert.ok(await waitFor(() => v.B.tables.rooms.arr.length === 1), '방이 다른 사람에게도 보임');
  for (const n of ['B', 'C', 'D']) tok[n] = ok(await v[n].enter(names[n])).token;
  assert.equal((await v.B.enter('다른이름')).data.token.length > 10, true, '이미 가입한 사람은 이름이 달라도 내 계정으로 로그인');
  const dupe = (await makeViewers(['X']));   // 다른 저장소라 영향 없음
  assert.ok(await waitFor(async () => (await st('A')).ranking.length === 4));
  assert.ok(await waitFor(async () => (await total()) === 4000), '가입 직후 총량');
  assert.equal((await st('A')).me.is_owner, true);

  /* ---- 닉네임 중복 ---- */
  const e2 = (await makeViewers(['P', 'Q'])).v;
  ok(await e2.P.enter('같은이름'));
  assert.ok(await waitFor(() => e2.Q.tables.users.arr.length === 1));
  assert.equal((await e2.Q.enter('같은이름')).code, 409);

  /* ---- 도박: 동시에 걸기 ---- */
  ok(await call('A', 'POST', '/api/bets', { title: '점심은?', options: ['한식', '양식'] }));
  assert.ok(await waitFor(async () => (await st('B')).bets.length === 1 && (await st('B')).bets[0].options.length === 2));
  const bet = (await st('B')).bets[0], [o1, o2] = bet.options;
  const rs = await Promise.all([['B', o1], ['C', o1], ['D', o2]].map(([n, o]) => call(n, 'POST', '/api/wager', { option_id: o.id, amount: 100 })));
  rs.forEach(ok);
  assert.ok(await waitFor(async () => (await st('A')).bets[0].total === 300), '동시에 건 3건이 모두 반영');
  assert.ok(await waitFor(async () => (await total()) === 4000 - 300), '건 돈이 정확히 빠짐');
  ok(await call('A', 'POST', '/api/bets/action', { bet_id: bet.id, action: 'resolve', option_id: o1.id }));
  assert.ok(await waitFor(async () => (await st('D')).bets[0].status === 'resolved'));
  assert.ok(await waitFor(async () => (await total()) === 4000), '정산 뒤 칩 총량 그대로');

  /* ---- 눈치게임: 동시 참가 ---- */
  const lr = ok(await call('A', 'POST', '/api/lun/create', { stake: 50, cap: 3, num: 1 }));
  assert.ok(await waitFor(async () => ok(await call('B', 'GET', '/api/lun')).rooms.length === 1));
  const joins = await Promise.all([['B', 2], ['C', 3], ['D', 4]].map(([n, num]) => call(n, 'POST', '/api/lun/join', { room_id: lr.id, num })));
  const okJoins = joins.filter((r) => !r.error).length;
  assert.equal(okJoins, 2, '자리가 3개라 두 명만 더 들어감 (A 포함 3명)');
  assert.equal(joins.filter((r) => r.error && r.code === 400).length, 1);
  assert.ok(await waitFor(async () => ok(await call('A', 'GET', '/api/lun')).recent.length === 1), '3명이 모이면 한 번만 결판');
  assert.ok(await waitFor(async () => (await total()) === 4000), '이긴 사람이 판돈을 가져가고 총량 그대로');

  /* ---- 돈뿌리기: 동시에 받기 ---- */
  const dr = ok(await call('A', 'POST', '/api/drop/create', { total: 100, cnt: 3 }));
  assert.ok(await waitFor(async () => ok(await call('B', 'GET', '/api/gifts')).drops.length === 1));
  const cl = await Promise.all(['B', 'C', 'D'].map((n) => call(n, 'POST', '/api/drop/claim', { id: dr.id })));
  cl.forEach(ok);
  assert.equal(cl.map((r) => r.data.amount).reduce((a, b) => a + b), 100, '동시에 받아도 합계가 정확히 100');
  assert.ok(await waitFor(async () => (await total()) === 4000), '뿌리기 뒤 총량');

  /* ---- 채팅: 임대 없이 바로 ---- */
  const t0 = Date.now();
  ok(await call('B', 'POST', '/api/chat', { bet_id: bet.id, text: '안녕' }));
  assert.ok(Date.now() - t0 < 500, '채팅은 기다리지 않음');
  assert.ok(await waitFor(async () => ok(await call('C', 'GET', '/api/chat?bet=' + bet.id + '&after=0')).some((m) => m.text === '안녕')));

  /* ---- 가위바위보 ---- */
  const rp = ok(await call('A', 'POST', '/api/rps/create', { hand: 'rock', stake: 30 }));
  assert.ok(await waitFor(async () => ok(await call('B', 'GET', '/api/rps')).rooms.length === 1));
  const rj = ok(await call('B', 'POST', '/api/rps/join', { room_id: rp.id, hand: 'paper' }));
  assert.equal(rj.outcome, 'win');
  assert.ok(await waitFor(async () => (await total()) === 4000), '가위바위보 뒤 총량');

  /* ---- 오래된 방은 자동 환불 (읽기 요청이 정리를 일으켜도 한 번만) ---- */
  const lr2 = ok(await call('C', 'POST', '/api/lun/create', { stake: 40, cap: 3, num: 5 }));
  assert.ok(await waitFor(async () => ok(await call('D', 'GET', '/api/lun')).rooms.some((r) => r.id === lr2.id)));
  const rowsNow = v.C.tables.lun.map.get(String(lr2.id));
  await v.C.db.collection('lun').doc(String(lr2.id)).set({ ...Object.fromEntries(Object.entries(rowsNow).filter(([k]) => k !== '_key')), created_at: Date.now() - 13 * 3600e3 });
  assert.ok(await waitFor(() => { const r = v.D.tables.lun.map.get(String(lr2.id)); return r && r.created_at < Date.now() - 12 * 3600e3; }));
  await Promise.all(['A', 'B', 'D'].map((n) => call(n, 'GET', '/api/lun')));
  assert.ok(await waitFor(async () => (await total()) === 4000), '만료 환불이 두 번 되지 않음');
  assert.equal(ok(await call('B', 'GET', '/api/lun')).rooms.some((r) => r.id === lr2.id), false);

  /* ---- 혼자 하는 게임: 블랙잭·슬롯 ---- */
  const bjs = ok(await call('B', 'POST', '/api/blackjack/start', { bet: 50 }));
  assert.ok(bjs.game);
  if (bjs.game.status === 'playing') ok(await call('B', 'POST', '/api/blackjack/stand', {}));
  const sp = ok(await call('C', 'POST', '/api/slots/spin', { bet: 50 }));
  assert.ok(Array.isArray(sp.reels) || sp.reels);

  /* ---- 블록 블라스트 대결: 동시 참가·동시 제출 ---- */
  await sleep(300); const T0 = await total();   // 혼자 하는 게임은 칩이 새로 생기거나 사라지므로 여기서부터 기준을 다시 잡음
  const war = ok(await call('A', 'POST', '/api/bbwar/create', { stake: 40, cap: 3 }));
  assert.ok(await waitFor(async () => ok(await call('B', 'GET', '/api/bbwar')).rooms.length === 1));
  const wj = await Promise.all(['B', 'C', 'D'].map((n) => call(n, 'POST', '/api/bbwar/join', { room_id: war.id })));
  assert.equal(wj.filter((r) => !r.error).length, 2, '자리가 3개라 두 명만 더 들어감');
  const joined = ['B', 'C', 'D'].filter((n, i) => !wj[i].error);
  const seeds = await Promise.all(['A', ...joined].map((n) => call(n, 'POST', '/api/bbwar/start', { room_id: war.id })));
  seeds.forEach(ok); assert.equal(new Set(seeds.map((r) => r.data.seed)).size, 1, '모두 같은 시드');
  const subs = await Promise.all(['A', ...joined].map((n, i) => call(n, 'POST', '/api/bbwar/submit', { room_id: war.id, score: [300, 900, 500][i] })));
  subs.forEach(ok); assert.equal(subs.filter((r) => r.data.resolved).length, 1, '결판은 한 번만');
  assert.ok(await waitFor(async () => (await total()) === T0), '대결 뒤 총량');
  assert.ok(await waitFor(async () => ok(await call('A', 'GET', '/api/bbwar')).recent.length === 1));

  /* ---- 관리자 ---- */
  assert.equal((await call('B', 'POST', '/api/admin/settings', { values: { gift_max: 500 } })).code, 403, '소유자가 아니면 관리자 기능 불가');
  ok(await call('A', 'POST', '/api/admin/settings', { values: { gift_max: 500 } }));
  assert.ok(await waitFor(async () => (await call('C', 'POST', '/api/drop/create', { total: 800, cnt: 3 })).code === 400), '바뀐 설정이 다른 사람에게도 적용');
  const ov = ok(await call('A', 'GET', '/api/admin/overview'));
  assert.equal(ov.users.length, 4);

  /* ---- 다른 화면(새로 연 사람)이 읽는 상태가 같음 ---- */
  assert.equal(JSON.stringify((await st('A')).ranking.map((r) => [r.name, r.points])), JSON.stringify((await st('D')).ranking.map((r) => [r.name, r.points])));
  Object.values(v).forEach((e) => e.stop());
  console.log('아티팩트 엔진 테스트 통과');
})().catch((e) => { console.error(e); process.exit(1); });
