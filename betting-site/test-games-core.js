// games-core.js 규칙 검증 (저장/통신 없이 순수 계산만)
const assert = require('node:assert');
const G = require('./games-core');
const rank = { A: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9, J: 10, Q: 11, K: 12 };
const c = (...rs) => rs.map((r) => rank[r]);                   // 카드 코드(무늬 상관없음)
const seeded = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const mk = (player, dealer, deck, bet = 100) => ({ bet, doubled: false, player: c(...player), dealer: c(...dealer), deck: c(...deck), status: 'playing', outcome: null, payout: 0 });

/* ----- 카드 점수 ----- */
assert.deepEqual(G.bjValue(c('A', 'K')), { total: 21, soft: true });
assert.deepEqual(G.bjValue(c('A', 'A', '9')), { total: 21, soft: true }, 'A 하나는 11, 하나는 1');
assert.equal(G.bjValue(c('A', 'A', 'K')).total, 12);
assert.equal(G.bjValue(c('10', '5', '7')).total, 22);
assert.deepEqual(G.bjValue(c('A', '5')), { total: 16, soft: true });
assert.deepEqual(G.bjValue(c('A', '5', '10')), { total: 16, soft: false }, 'A가 11이면 버스트라 1로 계산');
assert.equal(G.bjValue(c('J', 'Q')).total, 20);

/* ----- 덱 ----- */
const deck = G.bjNewDeck(seeded(1));
assert.deepEqual([...deck].sort((a, b) => a - b), Array.from({ length: 52 }, (_, i) => i), '52장이 한 장씩');
assert.notDeepEqual(deck, Array.from({ length: 52 }, (_, i) => i), '섞여 있어야 함');
const st = G.bjStart(100, seeded(7));
assert.equal(st.player.length + st.dealer.length + st.deck.length, 52);

/* ----- 시작하자마자 결판 ----- */
let s = mk(['A', 'K'], ['9', '7'], []); // 직접 만든 판을 start 와 같은 방식으로 판정하려고 내부 규칙을 stand/hit 로 확인
// (시작 판정은 bjStart 안에서만 하므로, 같은 규칙을 가진 카드 순서로 start 를 재현)
function startWith(player, dealer, bet = 100) {   // 덱 순서: 플레이어1, 딜러1, 플레이어2, 딜러2 → bjStart 가 이 순서로 뽑음
  const rigged = c(player[0], dealer[0], player[1], dealer[1]);
  const rest = G.bjNewDeck(seeded(3)).filter((x) => !rigged.includes(x));
  const order = [...rigged, ...rest];
  let i = 0; // Fisher-Yates 를 거치지 않도록 rnd 를 쓰지 않고, 덱을 직접 주입
  const orig = G.bjNewDeck; G.bjNewDeck = () => order.slice();
  try { return G.bjStart(bet, () => 0); } finally { G.bjNewDeck = orig; }
}
s = startWith(['A', 'K'], ['9', '7'], 100);
assert.equal(s.status, 'done'); assert.equal(s.outcome, 'blackjack'); assert.equal(s.payout, 250, '블랙잭은 3:2 → 건 돈 100 + 150');
s = startWith(['A', 'K'], ['9', '7'], 15);
assert.equal(s.payout, 37, '소수는 버림');
s = startWith(['A', 'K'], ['A', 'Q'], 100);
assert.equal(s.outcome, 'push'); assert.equal(s.payout, 100, '둘 다 블랙잭이면 무승부(원금)');
s = startWith(['9', '7'], ['A', 'K'], 100);
assert.equal(s.outcome, 'lose'); assert.equal(s.payout, 0); assert.equal(s.status, 'done', '딜러 블랙잭이면 바로 끝');
s = startWith(['10', '5'], ['9', '7'], 100);
assert.equal(s.status, 'playing');
const v = G.bjView(s);
assert.equal(v.dealer[1], null, '진행 중에는 딜러 둘째 카드가 응답에 없어야 함');
assert.equal(v.dealer[0].rank, '9'); assert.equal(v.dv.total, 9);
assert.ok(!JSON.stringify(v).includes('deck'), '남은 덱은 절대 안 보냄');

/* ----- 스탠드: 딜러 규칙 ----- */
s = mk(['10', '8'], ['10', '6'], ['5', '2']);   // 딜러 16 → 5를 받아 21
G.bjStand(s); assert.equal(G.bjValue(s.dealer).total, 21); assert.equal(s.outcome, 'lose');
s = mk(['10', '8'], ['10', '6'], ['K']);        // 딜러 16 → K → 26 버스트
G.bjStand(s); assert.equal(s.outcome, 'win'); assert.equal(s.payout, 200);
s = mk(['10', '8'], ['A', '6'], ['5']);         // 딜러 소프트 17 은 멈춤 → 18 > 17 플레이어 승
G.bjStand(s); assert.equal(s.dealer.length, 2, '딜러는 17이면(소프트 포함) 더 안 뽑음'); assert.equal(s.outcome, 'win');
s = mk(['10', '8'], ['10', '8'], ['5']);        // 18 vs 18 → 무승부
G.bjStand(s); assert.equal(s.outcome, 'push'); assert.equal(s.payout, 100);
s = mk(['10', '7'], ['10', '8'], []);           // 17 vs 18 → 패배
G.bjStand(s); assert.equal(s.outcome, 'lose'); assert.equal(s.payout, 0);

/* ----- 히트 ----- */
s = mk(['10', '6'], ['10', '7'], ['K']);        // 16 + K = 26 버스트
G.bjHit(s); assert.equal(s.outcome, 'bust'); assert.equal(s.payout, 0); assert.equal(s.status, 'done');
s = mk(['10', '6'], ['10', '7'], ['5']);        // 16 + 5 = 21 → 자동으로 멈추고 딜러 17 과 비교 → 승
G.bjHit(s); assert.equal(s.status, 'done'); assert.equal(s.outcome, 'win');
s = mk(['2', '3'], ['10', '7'], ['4', '5']);    // 5 + 4 = 9 → 계속 진행
G.bjHit(s); assert.equal(s.status, 'playing'); assert.equal(G.bjValue(s.player).total, 9);
assert.throws(() => G.bjHit(mk(['10', '6'], ['10', '7'], ['K', 'K']) && Object.assign(mk(['10', '6'], ['10', '7'], ['K']), { status: 'done' })), /끝난/);

/* ----- 더블다운 ----- */
s = mk(['5', '6'], ['10', '7'], ['10'], 100);   // 11 + 10 = 21, 딜러 17 → 승. 건 돈 2배(200) → 400 돌려받음
assert.equal(G.bjCanDouble(s), true);
G.bjDouble(s); assert.equal(s.doubled, true); assert.equal(s.outcome, 'win'); assert.equal(s.payout, 400);
assert.equal(G.bjView(s).net, 200, '더블다운 순이익 = 400 - 200');
s = mk(['5', '6'], ['10', '7'], ['K', '2']);    // 11 + 10 = 21 → 승. 다음 테스트용으로 다른 판
s = mk(['6', '6'], ['10', '7'], ['K'], 100);    // 12 + K = 22 버스트 → 잃음
G.bjDouble(s); assert.equal(s.outcome, 'bust'); assert.equal(s.payout, 0); assert.equal(G.bjView(s).net, -200, '더블다운에서 지면 2배를 잃음');
s = mk(['2', '3'], ['10', '7'], ['4', '5']); G.bjHit(s);
assert.equal(G.bjCanDouble(s), false, '히트한 뒤에는 더블다운 불가');
assert.throws(() => G.bjDouble(s), /더블다운/);

/* ----- 최저 유일 숫자 ----- */
assert.equal(G.lunWinner([1, 1, 3, 7]), 2, '겹친 1 은 무효 → 안 겹친 것 중 가장 작은 3');
assert.equal(G.lunWinner([2, 5, 9]), 0);
assert.equal(G.lunWinner([4, 4, 4]), -1, '전부 겹치면 승자 없음');
assert.equal(G.lunWinner([3, 3, 5, 5]), -1);
assert.equal(G.lunWinner([1, 1, 2, 2, 9]), 4, '작은 숫자들이 겹치면 겹치지 않은 큰 숫자가 이김');

/* ----- 사다리 ----- */
for (let n = 2; n <= 6; n++) for (let t = 0; t < 200; t++) {
  const rng = seeded(n * 1000 + t), rungs = G.ladderMake(n, rng);
  assert.equal(rungs.length, G.LADDER.ROWS);
  rungs.forEach((row) => { row.forEach((i) => assert.ok(i >= 0 && i < n - 1)); row.forEach((i) => assert.ok(!row.includes(i + 1), '이웃한 가로줄 금지')); });
  const ends = Array.from({ length: n }, (_, i) => G.ladderEnd(rungs, i));
  assert.deepEqual([...ends].sort(), Array.from({ length: n }, (_, i) => i), '각 출발 칸은 서로 다른 끝 칸으로 (겹치지 않음)');
  const path = G.ladderPath(rungs, 0); assert.equal(path[path.length - 1], ends[0]); assert.equal(path.length, G.LADDER.ROWS + 1);
}
{ // 가로줄이 왼쪽/오른쪽으로 치우치지 않아야 함 (예전엔 왼쪽이 오른쪽의 2배였음). 가운데 칸이 가장자리보다 조금 적은 건 규칙상 자연스러움
  for (const n of [3, 4, 5, 6]) {
    const rng = seeded(n), cnt = Array(n - 1).fill(0); let rows = 0;
    for (let k = 0; k < 8000; k++) G.ladderMake(n, rng).forEach((row) => { rows++; row.forEach((i) => cnt[i]++); });
    const rate = cnt.map((c) => c / rows);
    for (let i = 0; i < rate.length; i++) assert.ok(Math.abs(rate[i] - rate[rate.length - 1 - i]) < 0.03, `N=${n} 좌우 비대칭: ${rate.map((x) => x.toFixed(2))}`);
    assert.ok(Math.min(...rate) > 0.2, '가로줄이 너무 적음: ' + rate.map((x) => x.toFixed(2)));
  }
}
{ // 당첨 확률: 어느 출발 칸이든 1/4
  const rng = seeded(42), wins = [0, 0, 0, 0], N = 40000;
  for (let t = 0; t < N; t++) { const rungs = G.ladderMake(4, rng), we = G.ladderWinEnd(4, rng); for (let i = 0; i < 4; i++) if (G.ladderEnd(rungs, i) === we) wins[i]++; }
  wins.forEach((w) => assert.ok(Math.abs(w / N - 0.25) < 0.015, '출발 칸별 당첨 확률 ' + (w / N)));
}

/* ----- 슬롯 ----- */
assert.equal(G.SLOT.WEIGHTS.reduce((a, b) => a + b), 100);
assert.equal(G.slotMultiplier([5, 5, 5]), 200); assert.equal(G.slotMultiplier([0, 0, 0]), 3);
assert.equal(G.slotMultiplier([0, 0, 3]), 2); assert.equal(G.slotMultiplier([0, 3, 0]), 2); assert.equal(G.slotMultiplier([3, 0, 0]), 2);
assert.equal(G.slotMultiplier([0, 1, 2]), 0.5); assert.equal(G.slotMultiplier([1, 2, 3]), 0); assert.equal(G.slotMultiplier([1, 1, 2]), 0, '🍒 아닌 두 개는 꽝');
assert.equal(G.slotPayout(15, 0.5), 7, '소수는 버림');
const rtp = G.slotRtp(); assert.ok(rtp > 0.90 && rtp < 0.94, '이론 환수율 ' + rtp);
{ const rng = seeded(99); let bet = 0, back = 0; const N = 400000;
  for (let i = 0; i < N; i++) { bet += 100; back += G.slotPayout(100, G.slotSpin(rng).mult); }
  assert.ok(Math.abs(back / bet - rtp) < 0.03, `시뮬레이션 환수율 ${(back / bet).toFixed(3)} vs 이론 ${rtp.toFixed(3)}`); }
console.log('게임 규칙 테스트 통과 (슬롯 이론 환수율 ' + (rtp * 100).toFixed(1) + '%)');
