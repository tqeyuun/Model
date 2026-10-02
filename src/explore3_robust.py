"""전략 3 탐색 후보 강건성 점검 (사후 점검 — 후보를 고르는 용도가 아니라 걸러내는 용도).
data/explore/ (2018년까지)만 사용. 검증·최종 테스트 구간은 읽지 않는다.
1) 구간 끝 효과: 학습 구간을 2018-12-31(하락 바닥) 대신 2018-09-28(고점)에 끝냄
2) 5년 이동 구간 10개 (2005~2009 … 2014~2018): Δ가 양수인 비율
3) 세금: 실현이익 22% (공제 없음, 보수적)
4) 파라미터 민감도: 추세 이평 150/250일, 변동성 목표 12/18%, 2배 진입 하락 20%
5) L1 닷컴 하락 스트레스: 2000-02 ~ 2004-12
"""
import sys
import numpy as np
sys.path.insert(0, "src")
import explore3 as e

cal, px = e.build(); sig = e.make_signals(px)
S = 100 * (1 + ((px["SPY"].close.pct_change() + px["QQQ"].close.pct_change()) / 2).fillna(0)).cumprod()
for n in (150, 250): sig[f"trend{n}"] = S > S.rolling(n).mean()
g = lambda d, k: sig.at[d, k]
ST = ["SPY", "QQQ", "IEF"]; LV = ["SPY", "QQQ", "SSO", "QLD"]

def frontier(win):
    out = []
    for w in e.FRONTIER:
        df, sold, _ = e.simulate(cal, px, win, ST, lambda d, w=w: e.mix(w), "short", True); out.append(e.stats(df, sold))
    return out

STEADY = {
    "T2 추세·전환":       (ST, lambda d: e.mix(1.0) if g(d, "trend") else e.mix(.5)),
    "V1 변동성목표15%":   (ST, lambda d: e.mix(float(np.clip(.15 / g(d, "vol60"), .4, 1.0)))),
    "T2' 이평150":        (ST, lambda d: e.mix(1.0) if g(d, "trend150") else e.mix(.5)),
    "T2' 이평250":        (ST, lambda d: e.mix(1.0) if g(d, "trend250") else e.mix(.5)),
    "V1' 목표12%":        (ST, lambda d: e.mix(float(np.clip(.12 / g(d, "vol60"), .4, 1.0)))),
    "V1' 목표18%":        (ST, lambda d: e.mix(float(np.clip(.18 / g(d, "vol60"), .4, 1.0)))),
}

def steady_delta(win, fr, fn, tax=0.0):
    df, sold, _ = e.simulate(cal, px, win, ST, fn, "short", True, tax); s = e.stats(df, sold)
    return e.frontier_delta(fr, s["mdd"], s["final"]), s

def lev_vs(win, trig=.10):
    L1, _, t1 = e.simulate(cal, px, win, LV, lambda d: {"SSO": .5, "QLD": .5} if g(d, "dd52") >= trig else {"SPY": .5, "QQQ": .5}, "direct")
    f = float(np.mean([t.get("SSO", 0) + t.get("QLD", 0) for t in t1]))
    L0, _, _ = e.simulate(cal, px, win, LV, lambda d: {"SSO": f / 2, "QLD": f / 2, "SPY": (1 - f) / 2, "QQQ": (1 - f) / 2}, "direct")
    B, _, _ = e.simulate(cal, px, win, LV, lambda d: {"SPY": .5, "QQQ": .5}, "direct")
    a, c, b = e.stats(L1), e.stats(L0), e.stats(B)
    return a["final"] / c["final"] - 1, a["mdd"] - c["mdd"], a, b, f

print("== 1) 구간 끝 효과: 학습 구간 끝을 2018-09-28(고점)로 ==")
for win in (("2010-01-01", "2018-12-31"), ("2010-01-01", "2018-09-28")):
    fr = frontier(win)
    print(f"  {win[1]}: " + " | ".join(f"{k} Δ {steady_delta(win, fr, STEADY[k][1])[0]:+.1%}" for k in ("T2 추세·전환", "V1 변동성목표15%")))

print("\n== 2) 5년 이동 구간 (Δ: 같은 낙폭 고정 배분 대비 / L1: 고정 2배 대조 대비) ==")
wins = [(f"{y}-01-01", f"{y + 4}-12-31") for y in range(2005, 2015)]
rows = {k: [] for k in ("T2 추세·전환", "V1 변동성목표15%", "L1 하락시 2배")}
for win in wins:
    fr = frontier(win)
    for k in ("T2 추세·전환", "V1 변동성목표15%"): rows[k].append(steady_delta(win, fr, STEADY[k][1])[0])
    rows["L1 하락시 2배"].append(lev_vs(win)[0])
print(f"  {'':16}" + "".join(f"{w[0][2:4]}-{w[1][2:4]:>3}" for w in wins) + "   양수")
for k, v in rows.items():
    print(f"  {k:16}" + "".join(f"{x:>+7.1%}" for x in v) + f"   {np.mean(np.array(v) > 0):.0%}")

print("\n== 3) 세금 22% (실현이익, 공제 없음) ==")
for wk in ("pre", "train"):
    fr = frontier(wk)
    for k in ("T2 추세·전환", "V1 변동성목표15%"):
        d0, s0 = steady_delta(wk, fr, STEADY[k][1]); d1, s1 = steady_delta(wk, fr, STEADY[k][1], tax=.22)
        print(f"  {wk:5} {k:14} Δ 세전 {d0:+.1%} -> 세후 {d1:+.1%} (최종가치 {s1['final'] / s0['final'] - 1:+.1%})")

print("\n== 4) 파라미터 민감도 (Δ pre / train) ==")
frs = {wk: frontier(wk) for wk in ("pre", "train")}
for k, (_, fn) in STEADY.items():
    print(f"  {k:16} " + " / ".join(f"{steady_delta(wk, frs[wk], fn)[0]:+.1%}" for wk in ("pre", "train")))
for trig in (.10, .20):
    print(f"  L1 진입 -{trig:.0%}       " + " / ".join(f"{lev_vs(wk, trig)[0]:+.1%}" for wk in ("pre", "train")) + "  (대조 대비)")

print("\n== 5) L1 닷컴 하락 스트레스 2000-02 ~ 2004-12 ==")
vs, gap, a, b, f = lev_vs(("2000-02-01", "2004-12-31"))
print(f"  L1 최종 {a['final']:,.0f} / 100% 주식 {b['final']:,.0f} (입금 {59 * 1000:,}) | 대조 대비 {vs:+.1%} | 낙폭 L1 {a['mdd']:.1%} vs 100% 주식 {b['mdd']:.1%} | 2배 입금 비율 {f:.0%}")

print("\n== 6) L1 엄격한 대조: 평균 주식 노출을 L1과 같게 맞춘 고정 2배 비율 + 원금 대비 최대 손실 ==")
def worst_vs_principal(df): return (df.V / df.D.cumsum() - 1).min()
for win in ("pre", "train", ("2000-02-01", "2004-12-31")):
    L1, _, t1 = e.simulate(cal, px, win, LV, lambda d: {"SSO": .5, "QLD": .5} if g(d, "dd52") >= .10 else {"SPY": .5, "QQQ": .5}, "direct")
    a = e.stats(L1); lo, hi = 0.0, 1.0
    fixed = lambda f: e.simulate(cal, px, win, LV, lambda d: {"SSO": f / 2, "QLD": f / 2, "SPY": (1 - f) / 2, "QQQ": (1 - f) / 2}, "direct")[0]
    for _ in range(25):
        m = (lo + hi) / 2
        lo, hi = (m, hi) if e.stats(fixed(m))["expo"] < a["expo"] else (lo, m)
    L0 = fixed((lo + hi) / 2); c = e.stats(L0)
    B = e.simulate(cal, px, win, LV, lambda d: {"SPY": .5, "QQQ": .5}, "direct")[0]; b = e.stats(B)
    name = win if isinstance(win, str) else "dotcom"
    print(f"  {name:6} 노출 {a['expo']:.0%} | 최종 L1 {a['final']:,.0f} / 노출맞춘 대조(2배 {(lo + hi) / 2:.0%}) {c['final']:,.0f} ({a['final'] / c['final'] - 1:+.1%}) / 100% 주식 {b['final']:,.0f}"
          f" | 원금 대비 최대 손실 L1 {worst_vs_principal(L1):.0%}, 대조 {worst_vs_principal(L0):.0%}, 100% 주식 {worst_vs_principal(B):.0%}")
