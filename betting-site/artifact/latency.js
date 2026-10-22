// 버튼을 눌렀을 때 서버(저장소)와 몇 번 오가고 얼마나 걸리는지 잼 (개발용). 왕복 한 번을 평균 L ms 로 흉내 냄
const Engine = require(process.env.ENGINE || './engine'), { makeGS } = require('../build-artifact-core'), { createStore } = require('./mockdb');
(async () => {
  const L = +process.env.L || 200;    // 호출 하나가 0~L ms (평균 L/2)
  const store = createStore(), mk = (n) => new Engine({ db: store.viewer({ latency: L, name: n }), uid: 'u' + n + 'abcdefghijklmnop', isOwner: false, makeGS });
  const A = mk('A'), B = mk('B'); A.gs.CFG.LUCKY_CHANCE = 0; B.gs.CFG.LUCKY_CHANCE = 0;
  await A.start(); await B.start();
  const ta = (await A.enter('에이')).data.token; await new Promise((r) => setTimeout(r, L * 3));
  const tb = (await B.enter('비이')).data.token; await new Promise((r) => setTimeout(r, L * 3));
  await A.call(ta, 'POST', '/api/bets', { title: '시험', options: ['가', '나'] }); await new Promise((r) => setTimeout(r, L * 4));
  const opt = (await B.call(tb, 'GET', '/api/state')).data.bets[0].options[0].id;
  const stats = {};
  async function run(name, eng, tk, m, u, b) {
    await new Promise((r) => setTimeout(r, 1500));      // 앞 동작의 임대가 끝나도록 (연속 동작이 아니라 첫 동작의 지연을 잼)
    const c0 = store.state.calls, t0 = Date.now(); const r = await eng.call(tk, m, u, b); const dt = Date.now() - t0;
    (stats[name] = stats[name] || []).push([dt, store.state.calls - c0]); if (r.error) console.log(name, '오류', r.error);
  }
  const R = +process.env.R || 6;
  for (let i = 0; i < R; i++) {
    await run('걸기', i % 2 ? B : A, i % 2 ? tb : ta, 'POST', '/api/wager', { option_id: opt, amount: 10 });
    await run('도박 만들기', A, ta, 'POST', '/api/bets', { title: '시험 ' + i, options: ['가', '나'] });
    await run('가위바위보 방', B, tb, 'POST', '/api/rps/create', { hand: 'rock', stake: 10 + i });
  }
  for (const [k, v] of Object.entries(stats)) { const avg = (i) => v.reduce((s, x) => s + x[i], 0) / v.length; console.log(k.padEnd(14), '평균', avg(0).toFixed(0).padStart(5), 'ms | 호출', avg(1).toFixed(1).padStart(5), '번'); }
  process.exit(0);
})();
