// 읽기 속도 측정 (개발용): 친구들이 오래 쓴 뒤의 데이터 양으로 state/chat/lun 응답 시간을 잼
const Engine = require('./engine'), { makeGS } = require('../build-artifact-core'), { createStore } = require('./mockdb');
(async () => {
  const store = createStore(), v = store.viewer(), U = +process.env.U || 12, B = +process.env.B || 400, W = +process.env.W || 5000, M = +process.env.M || 400;
  const now = Date.now(), put = (c, id, d) => v.doc(c + '/' + id).set(d);
  const ps = [];
  ps.push(put('rooms', 1, { id: 1, grp: 'g_dobak', code: 'dobak', created_at: now }));
  for (let i = 1; i <= U; i++) ps.push(put('users', i, { id: i, name: '유저' + i, salt: 's', hash: 'h:' + i, points: 1000 + i * 37, last_aid: 0, created_at: now, grp: 'g_dobak', dev: 'dev' + String(i).padStart(14, '0'), approved: 1 }));
  let oid = 0, wid = 0;
  for (let b = 1; b <= B; b++) {
    const open = b > B - 5;
    ps.push(put('bets', b, { id: b, title: '도박 ' + b, creator_id: 1 + (b % U), status: open ? 'open' : 'resolved', winner: open ? '' : b * 3 - 1, closes_at: '', created_at: now - (B - b) * 60000 }));
    for (let o = 0; o < 3; o++) ps.push(put('options', ++oid, { id: oid, bet_id: b, label: '선택지' + o }));
  }
  for (let w = 1; w <= W; w++) { const b = 1 + (w % B); ps.push(put('wagers', w, { id: w, bet_id: b, option_id: (b - 1) * 3 + 1 + (w % 3), user_id: 1 + (w % U), amount: 10 + (w % 9) * 10, payout: w % 2 ? 30 : 0, lucky: 0, created_at: now - w * 1000 })); }
  for (let m = 1; m <= M; m++) ps.push(put('messages', now * 1000 + m, { id: now * 1000 + m, user_id: 1 + (m % U), text: '메시지 ' + m, created_at: now - (M - m) * 1000, bet_id: 1 + (m % B) }));
  await Promise.all(ps);
  const e = new Engine({ db: store.viewer(), uid: 'ubenchviewer0000000000', isOwner: false, makeGS }); const t0 = Date.now(); await e.start(); console.log('초기 불러오기', Date.now() - t0, 'ms');
  const dev = e.devKey(), me = e.tables.users.arr.find((u) => u.id === 3); me.dev = dev; me.hash = 'h:' + dev.slice(0, 16) + ':' + me.salt;   // 시험용: 3번 유저로 로그인
  const t = (await e.enter()).data.token;
  const time = async (name, fn, n = 30) => { const s = process.hrtime.bigint(); let sz = 0; for (let i = 0; i < n; i++) { const r = await fn(); sz = JSON.stringify(r).length; } console.log(name.padEnd(14), (Number(process.hrtime.bigint() - s) / 1e6 / n).toFixed(1).padStart(7), 'ms/회', String(sz).padStart(8), '바이트'); };
  await time('state', () => e.call(t, 'GET', '/api/state'));
  await time('lun', () => e.call(t, 'GET', '/api/lun'));
  await time('ladder', () => e.call(t, 'GET', '/api/ladder'));
  await time('bbwar', () => e.call(t, 'GET', '/api/bbwar'));
  await time('gifts', () => e.call(t, 'GET', '/api/gifts'));
  await time('chat', () => e.call(t, 'GET', '/api/chat?bet=5&after=0'));
  await time('blockblast', () => e.call(t, 'GET', '/api/blockblast'));
  e.stop(); process.exit(0);
})();
