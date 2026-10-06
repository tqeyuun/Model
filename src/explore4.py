"""모델 G: 다자산 추세 (GTAA 방식) 탐색. data/explore/ (2018년까지)만 읽는다.
외부 근거: 자산군별 시계열 모멘텀 (Moskowitz·Ooi·Pedersen 2012, Hurst 외 2017 'A Century of Evidence on Trend-Following', Faber 2007).
지금까지와 다른 점: 신호를 미국 주식 하나가 아니라 8개 자산 각각에 따로 건다.

규칙 (결과 보기 전 고정)
- 8개 자산 균등 1/8: SPY, QQQ, EFA(선진국), EEM(신흥국), VNQ(리츠), IEF(중기채), TLT(장기채), GLD(금)
- 매달 첫 거래일, 자산별로 전일 종가가 200일 이평 위면 1/8 보유, 아래면(또는 이력 부족) 그 몫을 SHY(단기채)로
- 입금 리밸런싱 + 자산군 10%p 밴드 매도 (explore3 엔진 그대로), 비용 0.075%, 현금 0%
대조: G0 = 같은 8개 자산 고정 균등 (추세 없음) / 주식·IEF 고정 배분 곡선 (Δ)

성공 기준 (결과 보기 전 고정, 전부 만족해야 함)
1. 두 구간(2005~09, 2010~18) 모두 Δ > 0 (같은 낙폭의 주식·IEF 고정 배분보다 최종가치 높음)
2. 두 구간 모두 G0보다 최대낙폭 작고 샤프 높음 (추세가 분산 효과 위에 더한 게 있는지)
3. 강건성: 학습 끝날짜 2018-09-28에서도 Δ > 0 / 5년 이동 구간 10개 중 70% 이상 Δ > 0 / 세금 22% 후에도 두 구간 Δ > 0
"""
import sys
import numpy as np
sys.path.insert(0, "src")
import explore3 as e

ASSETS = ["SPY", "QQQ", "EFA", "EEM", "VNQ", "IEF", "TLT", "GLD"]
e.EXPO.update({"EEM": 1, "VNQ": 1})   # 주식성 자산 (노출 계산·밴드 자산군)

def build():
    cal, px = e.build()
    for t in ["EEM", "TLT", "VNQ"]: px[t] = e.load_x(t).reindex(cal).ffill()
    on = {t: px[t].close > px[t].close.rolling(200).mean() for t in ASSETS}   # 이력 200일 미만이면 False
    return cal, px, on

def g_fn(on):
    def fn(d):
        w = {t: (1 / 8 if on[t].at[d] else 0.0) for t in ASSETS}
        w["SHY"] = 1 - sum(w.values()); return w
    return fn

def g0_fn(d): return {**{t: 1 / 8 for t in ASSETS}, "SHY": 0.0}

def frontier(cal, px, win):
    out = []
    for w in e.FRONTIER:
        df, sold, _ = e.simulate(cal, px, win, ["SPY", "QQQ", "IEF"], lambda d, w=w: e.mix(w), "short", True); out.append(e.stats(df, sold))
    return out

def evaluate(cal, px, on, win, tax=0.0):
    fr = frontier(cal, px, win)
    G, sg, _ = e.simulate(cal, px, win, ASSETS + ["SHY"], g_fn(on), "short", True, tax)
    G0, s0, _ = e.simulate(cal, px, win, ASSETS + ["SHY"], g0_fn, "short", True, tax)
    a, b = e.stats(G, sg), e.stats(G0, s0)
    a["delta"] = e.frontier_delta(fr, a["mdd"], a["final"]); b["delta"] = e.frontier_delta(fr, b["mdd"], b["final"])
    return a, b, fr[0]

if __name__ == "__main__":
    cal, px, on = build(); ok = True
    print(e.HEAD + f"{'Δ':>8}")
    for win in ("pre", "train"):
        a, b, base = evaluate(cal, px, on, win)
        print(f"-- {win} {e.WINDOWS[win]}")
        print(e.fmt("G 다자산 추세", a, base, f"{a['delta']:>+8.1%}")); print(e.fmt("G0 같은 자산 고정", b, base, f"{b['delta']:>+8.1%}"))
        c1 = a["delta"] > 0; c2 = a["mdd"] > b["mdd"] and a["sharpe"] > b["sharpe"]
        print(f"   기준1 Δ>0 {'O' if c1 else 'X'} | 기준2 G0보다 낙폭·샤프 우위 {'O' if c2 else 'X'}"); ok &= c1 and c2
    print("\n-- 강건성")
    d = evaluate(cal, px, on, ("2010-01-01", "2018-09-28"))[0]["delta"]; print(f"   끝날짜 2018-09-28 Δ {d:+.1%}"); ok &= d > 0
    roll = [evaluate(cal, px, on, (f"{y}-01-01", f"{y + 4}-12-31"))[0]["delta"] for y in range(2005, 2015)]
    pos = np.mean(np.array(roll) > 0)
    print("   5년 이동 구간 Δ: " + " ".join(f"{x:+.1%}" for x in roll) + f"  -> 양수 {pos:.0%}"); ok &= pos >= .7
    for win in ("pre", "train"):
        d = evaluate(cal, px, on, win, tax=.22)[0]["delta"]; print(f"   세금 22% 후 {win} Δ {d:+.1%}"); ok &= d > 0
    print(f"\n최종: {'성공 기준 전부 충족' if ok else '미달'}")
