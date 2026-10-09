/**
 * 도박장 게임 규칙 (순수 계산만 — 저장/통신은 서버가 맡음).
 * Node 서버(server.js)와 구글 앱스 스크립트(gas/Games.gs)가 이 파일을 똑같이 씁니다.
 * 수정하면 `node build-gas.js` 로 gas/Games.gs 를 다시 만드세요.
 *
 * 난수는 모두 rnd() (0 이상 1 미만)로 받아서, 테스트에서는 고정된 값을 넣을 수 있어요.
 */
var GAMES = (function () {
  var G = {};
  function rint(n, rnd) { return Math.floor((rnd || Math.random)() * n); }

  /* ================= 🤫 최저 유일 숫자 ================= */
  G.LUN = { MIN: 1, MAX: 10, MIN_PLAYERS: 3, MAX_PLAYERS: 6 };
  /** nums: 낸 숫자들(참가 순서). 다른 사람과 겹치지 않은 숫자 중 가장 작은 걸 낸 사람의 index. 없으면 -1 */
  G.lunWinner = function (nums) {
    var count = {};
    nums.forEach(function (n) { count[n] = (count[n] || 0) + 1; });
    var best = -1;
    nums.forEach(function (n, i) { if (count[n] === 1 && (best < 0 || n < nums[best])) best = i; });
    return best;
  };

  /* ================= 🪜 사다리타기 ================= */
  G.LADDER = { MIN_SLOTS: 2, MAX_SLOTS: 6, ROWS: 9 };
  /** 사다리 만들기. rungs[행] = 그 행에서 가로줄이 놓인 칸 번호들(i는 i번과 i+1번 세로줄 사이). 이웃한 가로줄은 안 놓음.
   *  놓을 자리를 무작위 순서로 훑어서, 왼쪽/오른쪽 어느 쪽도 치우치지 않게 만들어요. */
  G.ladderMake = function (slots, rnd) {
    var rungs = [];
    for (var r = 0; r < G.LADDER.ROWS; r++) {
      var order = [], row = [], i, j, t;
      for (i = 0; i < slots - 1; i++) order.push(i);
      for (i = order.length - 1; i > 0; i--) { j = rint(i + 1, rnd); t = order[i]; order[i] = order[j]; order[j] = t; }
      order.forEach(function (k) {
        if ((rnd || Math.random)() < 0.7 && row.indexOf(k - 1) < 0 && row.indexOf(k + 1) < 0) row.push(k);
      });
      row.sort(function (x, y) { return x - y; });
      rungs.push(row);
    }
    return rungs;
  };
  /** 위에서 start번 칸으로 출발해서 내려간 끝 칸 */
  G.ladderEnd = function (rungs, start) {
    var pos = start;
    rungs.forEach(function (row) {
      if (row.indexOf(pos) >= 0) pos += 1;
      else if (row.indexOf(pos - 1) >= 0) pos -= 1;
    });
    return pos;
  };
  /** 출발 칸별 지나간 길(행마다의 위치). 그림 그리기용 */
  G.ladderPath = function (rungs, start) {
    var pos = start, path = [pos];
    rungs.forEach(function (row) {
      if (row.indexOf(pos) >= 0) pos += 1;
      else if (row.indexOf(pos - 1) >= 0) pos -= 1;
      path.push(pos);
    });
    return path;
  };
  /** 당첨 끝 칸을 무작위로 정함 (사다리와 독립 → 어느 출발 칸이든 당첨 확률은 똑같이 1/칸수) */
  G.ladderWinEnd = function (slots, rnd) { return rint(slots, rnd); };

  /* ================= 🃏 블랙잭 ================= */
  G.BJ = { MIN_BET: 10, MAX_BET: 500, BLACKJACK_PAYS: 2.5 };   // 블랙잭은 3:2 (건 돈 + 1.5배 = 총 2.5배 돌려받음)
  var SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  G.bjCard = function (code) { return { rank: RANKS[code % 13], suit: SUITS[Math.floor(code / 13)], red: Math.floor(code / 13) === 1 || Math.floor(code / 13) === 2 }; };
  G.bjNewDeck = function (rnd) {
    var d = [], i, j, t;
    for (i = 0; i < 52; i++) d.push(i);
    for (i = 51; i > 0; i--) { j = rint(i + 1, rnd); t = d[i]; d[i] = d[j]; d[j] = t; }   // 섞기 (Fisher-Yates)
    return d;
  };
  /** 카드 점수. A는 11 또는 1 중 유리한 쪽, J/Q/K는 10 */
  G.bjValue = function (codes) {
    var total = 0, aces = 0;
    codes.forEach(function (c) {
      var r = c % 13;
      if (r === 0) { aces++; total += 11; } else total += r >= 9 ? 10 : r + 1;
    });
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return { total: total, soft: aces > 0 };
  };
  var isNatural = function (codes) { return codes.length === 2 && G.bjValue(codes).total === 21; };

  /** 새 판: 건 돈 bet. 플레이어 2장, 딜러 2장(한 장은 가려짐). 시작하자마자 블랙잭이면 바로 끝남. */
  G.bjStart = function (bet, rnd) {
    var deck = G.bjNewDeck(rnd);
    var s = { bet: bet, doubled: false, player: [deck[0], deck[2]], dealer: [deck[1], deck[3]], deck: deck.slice(4), status: 'playing', outcome: null, payout: 0 };
    var pn = isNatural(s.player), dn = isNatural(s.dealer);
    if (pn && dn) finish(s, 'push');
    else if (pn) finish(s, 'blackjack');
    else if (dn) finish(s, 'lose');       // 딜러가 블랙잭이면 바로 패배 (딜러 카드 공개)
    return s;
  };
  function wager(s) { return s.bet * (s.doubled ? 2 : 1); }
  function finish(s, outcome) {
    s.status = 'done'; s.outcome = outcome;
    var w = wager(s);
    s.payout = outcome === 'blackjack' ? Math.floor(w * G.BJ.BLACKJACK_PAYS)
      : outcome === 'win' ? w * 2
      : outcome === 'push' ? w : 0;
    return s;
  }
  function draw(s, who) { s[who].push(s.deck.shift()); }
  function dealerPlayAndCompare(s) {
    while (G.bjValue(s.dealer).total < 17) draw(s, 'dealer');   // 딜러는 16 이하면 계속 뽑고 17 이상이면 멈춤
    var p = G.bjValue(s.player).total, d = G.bjValue(s.dealer).total;
    return finish(s, d > 21 || p > d ? 'win' : p === d ? 'push' : 'lose');
  }
  /** 히트: 카드 한 장 더. 21 초과면 버스트(패배), 정확히 21이면 자동으로 멈춤 */
  G.bjHit = function (s) {
    if (s.status !== 'playing') throw new Error('끝난 게임이에요.');
    draw(s, 'player');
    var v = G.bjValue(s.player).total;
    if (v > 21) return finish(s, 'bust');
    if (v === 21) return dealerPlayAndCompare(s);
    return s;
  };
  /** 스탠드: 그만 받고 딜러 차례 */
  G.bjStand = function (s) {
    if (s.status !== 'playing') throw new Error('끝난 게임이에요.');
    return dealerPlayAndCompare(s);
  };
  /** 더블다운: 처음 두 장일 때만. 건 돈을 2배로 하고 카드 딱 한 장만 받고 끝 (호출하는 쪽이 추가금을 미리 차감) */
  G.bjCanDouble = function (s) { return s.status === 'playing' && s.player.length === 2 && !s.doubled; };
  G.bjDouble = function (s) {
    if (!G.bjCanDouble(s)) throw new Error('지금은 더블다운을 할 수 없어요.');
    s.doubled = true;
    draw(s, 'player');
    if (G.bjValue(s.player).total > 21) return finish(s, 'bust');
    return dealerPlayAndCompare(s);
  };
  /** 화면에 보낼 모습. 진행 중에는 딜러의 두 번째 카드가 null(가려짐) — 서버가 모르는 척하는 게 아니라 아예 안 보냄 */
  G.bjView = function (s) {
    var playing = s.status === 'playing';
    return {
      bet: s.bet, doubled: s.doubled, status: s.status, outcome: s.outcome,
      player: s.player.map(G.bjCard), pv: G.bjValue(s.player),
      dealer: playing ? [G.bjCard(s.dealer[0]), null] : s.dealer.map(G.bjCard),
      dv: playing ? G.bjValue([s.dealer[0]]) : G.bjValue(s.dealer),
      can_double: G.bjCanDouble(s),
      wagered: wager(s), payout: s.payout, net: s.status === 'done' ? s.payout - wager(s) : null,
    };
  };

  /* ================= 🎰 슬롯머신 ================= */
  G.SLOT = {
    MIN_BET: 10, MAX_BET: 500,
    SYMBOLS: ['🍒', '🍋', '🔔', '⭐', '💎', '7️⃣'],
    WEIGHTS: [30, 25, 20, 15, 8, 2],                    // 릴 하나에서 각 그림이 나올 가능성 (합계 100)
    TRIPLE: [3, 5, 8, 20, 50, 200],                    // 같은 그림 3개 → 건 돈의 몇 배
    CHERRY2: 2, CHERRY1: 0.5,                           // 🍒가 정확히 2개 / 1개일 때
  };
  function pickSymbol(rnd) {
    var r = (rnd || Math.random)() * 100, acc = 0;
    for (var i = 0; i < G.SLOT.WEIGHTS.length; i++) { acc += G.SLOT.WEIGHTS[i]; if (r < acc) return i; }
    return G.SLOT.WEIGHTS.length - 1;
  }
  /** reels: 그림 번호 3개 → 배수 */
  G.slotMultiplier = function (reels) {
    var a = reels[0], b = reels[1], c = reels[2];
    if (a === b && b === c) return G.SLOT.TRIPLE[a];
    var cherries = reels.filter(function (x) { return x === 0; }).length;
    if (cherries === 2) return G.SLOT.CHERRY2;
    if (cherries === 1) return G.SLOT.CHERRY1;
    return 0;
  };
  G.slotSpin = function (rnd) { var reels = [pickSymbol(rnd), pickSymbol(rnd), pickSymbol(rnd)]; return { reels: reels, mult: G.slotMultiplier(reels) }; };
  G.slotPayout = function (bet, mult) { return Math.floor(bet * mult); };
  /** 이론상 환수율 (건 돈 대비 평균적으로 돌려받는 비율) */
  G.slotRtp = function () {
    var T = 100, r = 0, a, b, c;
    for (a = 0; a < 6; a++) for (b = 0; b < 6; b++) for (c = 0; c < 6; c++)
      r += (G.SLOT.WEIGHTS[a] / T) * (G.SLOT.WEIGHTS[b] / T) * (G.SLOT.WEIGHTS[c] / T) * G.slotMultiplier([a, b, c]);
    return r;
  };

  return G;
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GAMES;
