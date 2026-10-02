"""전략 3 후보 탐색 (탐색 전용, 사전 등록 아님).
읽는 데이터: data/explore/ (2018-12-31 이전 행만 존재). 검증(2019~2022)·최종 테스트(2023~)는 읽지 않는다.
탐색 구간: pre 2005~2009 (2008 금융위기 포함), train 2010~2018.

후보와 선별 기준은 결과를 보기 전에 아래처럼 고정했다.
- 꾸준형 (D·T·V·M): 탐색 두 구간 모두에서 '같은 최대낙폭의 주식·IEF 고정 배분'보다 최종가치가 높을 것 (Δ > 0).
  주식 비중만 낮춰도 낙폭은 줄어드므로, 타이밍·자산 선택의 효과는 고정 배분 곡선 대비로만 본다.
- 수익형 (L·E): 탐색 두 구간 모두에서 '같은 평균 비중의 고정 배분 대조'보다 최종가치가 높고, 최대낙폭이 5%p 넘게 나빠지지 않을 것.
공통 규칙: 월 1,000 입금(월 첫 거래일), 판단은 전일 종가, 체결은 당일 시가, 편도 0.075%, 현금 0%.
주식 = SPY·QQQ 반반. 하락 신호의 '전고점'은 직전 252거래일 최고가 (2000년 같은 오래된 고점에 묶이지 않게).
"""
import sys
import numpy as np, pandas as pd

FEE, DEPOSIT, BAND, LEV_COST = 0.00075, 1000.0, 0.10, 0.0091
WINDOWS = {"pre": ("2005-01-01", "2009-12-31"), "train": ("2010-01-01", "2018-12-31")}
EXPO = {"SPY": 1, "QQQ": 1, "EFA": 1, "SSO": 2, "QLD": 2}   # 주식 노출 (2배 ETF는 2)
GROUP = lambda t: "주식" if t in EXPO else t                  # 밴드는 자산군(주식·채권·금) 단위로 본다 (모델 5와 같음)
FRONTIER = [1.0, .9, .8, .7, .6, .5, .4, .3]

def load_x(t):
    d = pd.read_csv(f"data/explore/{t}.csv", index_col=0, parse_dates=True)
    assert d.index.max() < pd.Timestamp("2019-01-01")
    f = d.adjclose / d.close
    return pd.DataFrame({"open": d.open * f, "close": d.adjclose})

def lev2(px, rate):
    """2배 일일 레버리지 ETF 합성: 2 x 일간수익률 - (보수 0.91% + 1배분 차입 금리)/252. 시가 = 전일 종가 x (1 + 2 x 야간 수익률)."""
    c, o = px.close, px.open
    close = 100 * (1 + 2 * c.pct_change().fillna(0) - (LEV_COST + rate) / 252).cumprod()
    opn = close.shift(1) * (1 + 2 * (o / c.shift(1) - 1)); opn.iloc[0] = 100.0
    return pd.DataFrame({"open": opn, "close": close})

def build():
    raw = {t: load_x(t) for t in ["SPY", "QQQ", "IEF", "SHY", "GLD", "EFA"]}
    cal = raw["SPY"].index
    px = {t: v.reindex(cal).ffill() for t, v in raw.items()}   # 상장 전은 NaN 유지
    r = pd.read_csv("data/explore/rates.csv", index_col=0, parse_dates=True)["DTB3"]
    rate = (r.reindex(r.index.union(cal)).ffill().reindex(cal).shift(1) / 100).fillna(0)
    px["SSO"], px["QLD"] = lev2(px["SPY"], rate), lev2(px["QQQ"], rate)
    return cal, px

def make_signals(px):
    """날짜 d의 값은 d 종가까지의 정보. 전략은 전일(d-1) 값만 쓴다."""
    S = 100 * (1 + ((px["SPY"].close.pct_change() + px["QQQ"].close.pct_change()) / 2).fillna(0)).cumprod()
    r = S.pct_change()
    sig = pd.DataFrame({
        "trend": S > S.rolling(200).mean(),
        "dd52": 1 - S / S.rolling(252, min_periods=1).max(),
        "vol60": r.rolling(60).std() * np.sqrt(252),
        "mom12": S.pct_change(252) > px["SHY"].close.pct_change(252),
    })
    for t in ["SPY", "QQQ", "EFA"]:
        c = px[t].close
        sig[f"score_{t}"] = ((1 - c / c.rolling(252, min_periods=1).max())
                             / (c.pct_change().rolling(252, min_periods=20).std() * np.sqrt(252))).fillna(0)
    return sig

def simulate(cal, px, window, assets, target_fn, mode="short", sell=False, tax=0.0):
    """월 첫 거래일: target_fn(전일) -> 목표 비중.
    mode 'short': 입금을 목표 대비 모자란 자산부터 채움 / 'direct': 입금을 목표 비중대로 나눔.
    sell=True: 전일 종가 기준 어느 자산군이든 목표에서 10%p 넘게 벗어나면 전체를 목표로 (매도 포함).
    tax>0: 연간 실현이익(평균단가 기준, 손익 통산)에 세율을 매겨 다음 해 첫 입금에서 낸다 (공제 없음 = 보수적)."""
    a, b = WINDOWS[window] if isinstance(window, str) else window; pos = np.where((cal >= a) & (cal <= b))[0]
    O = {t: px[t].open.values for t in assets}; C = {t: px[t].close.values for t in assets}
    assert all(np.isfinite(O[t][pos[0] - 1:pos[-1] + 1]).all() and np.isfinite(C[t][pos[0] - 1:pos[-1] + 1]).all() for t in assets)
    sh = dict.fromkeys(assets, 0.0); basis = dict.fromkeys(assets, 0.0); gain = {}; sold = 0.0; tgts = []; prev_m = None
    D, V, X = np.zeros(len(pos)), np.zeros(len(pos)), np.zeros(len(pos))
    for j, i in enumerate(pos):
        dt = cal[i]
        if (dt.year, dt.month) != prev_m:
            prev_m = (dt.year, dt.month); D[j] = DEPOSIT
            tgt = target_fn(cal[i - 1]); tgts.append(tgt)
            assert abs(sum(tgt.values()) - 1) < 1e-9 and set(tgt) <= set(assets), tgt
            hold = {t: sh[t] * C[t][i - 1] for t in assets}; tot_v = sum(hold.values()); cash = DEPOSIT
            if tax and dt.month == 1 and gain.get(dt.year - 1, 0) > 0:   # 전년도 세금은 이번 입금에서 (모자라면 보유분 비례 매도)
                due = tax * gain.pop(dt.year - 1); cash -= due; D[j] = cash
                if cash < 0:
                    f = -cash / tot_v
                    for t in assets: basis[t] *= 1 - f; sh[t] *= 1 - f
                    cash = 0.0; hold = {t: sh[t] * C[t][i - 1] for t in assets}; tot_v = sum(hold.values())
            if sell and tot_v > 0 and max(abs(v) for v in groups({t: hold[t] / tot_v - tgt.get(t, 0.0) for t in assets}).values()) > BAND + 1e-12:
                tot = tot_v + DEPOSIT
                for t in assets:
                    over = hold[t] - tgt.get(t, 0.0) * tot
                    if over > 1e-9:
                        s = over / C[t][i - 1]; out = basis[t] * s / sh[t]; basis[t] -= out
                        gain[dt.year] = gain.get(dt.year, 0.0) + s * O[t][i] * (1 - FEE) - out
                        sh[t] -= s; cash += s * O[t][i] * (1 - FEE); sold += s * O[t][i]
                hold = {t: sh[t] * C[t][i - 1] for t in assets}
            if mode == "direct":
                alloc = {t: cash * tgt.get(t, 0.0) for t in assets}
            else:
                tot = sum(hold.values()) + cash
                short = {t: max(0.0, tgt.get(t, 0.0) * tot - hold[t]) for t in assets}; s_ = sum(short.values())
                if s_ <= 0: alloc = {t: cash * tgt.get(t, 0.0) for t in assets}
                elif s_ >= cash: alloc = {t: cash * short[t] / s_ for t in assets}
                else: alloc = {t: short[t] + (cash - s_) * tgt.get(t, 0.0) for t in assets}
            for t in assets:
                if alloc[t] > 0: sh[t] += alloc[t] * (1 - FEE) / O[t][i]; basis[t] += alloc[t]
        vals = {t: sh[t] * C[t][i] for t in assets}; V[j] = sum(vals.values())
        X[j] = sum(v * EXPO.get(t, 0) for t, v in vals.items()) / V[j]
    return pd.DataFrame({"D": D, "V": V, "expo": X}, index=cal[pos]), sold, tgts

def groups(w):
    out = {}
    for t, v in w.items(): out[GROUP(t)] = out.get(GROUP(t), 0.0) + v
    return out

def stats(df, sold=0.0):
    den = df.V.shift(1, fill_value=0) + df.D
    ret = (df.V / den.where(den > 0) - 1).fillna(0.0)
    nav = (1 + ret).cumprod()
    return dict(final=df.V.iloc[-1], mdd=(nav / nav.cummax() - 1).min(), sharpe=ret.mean() / ret.std() * np.sqrt(252),
                expo=df.expo.mean(), sold=sold / df.D.sum())

def mix(w, other="IEF"): return {"SPY": w / 2, "QQQ": w / 2, other: 1 - w}

def capped(w, cap=.7):
    s = sum(w.values()); w = {k: v / s for k, v in w.items()}
    for _ in range(10):
        over = [k for k in w if w[k] > cap + 1e-12]
        if not over: break
        for k in over:
            ex = w[k] - cap; w[k] = cap
            rest = [j for j in w if w[j] < cap - 1e-12]; s = sum(w[j] for j in rest)
            for j in rest: w[j] += ex * w[j] / s
    return w

def steady_candidates(sig):
    g = lambda d, k: sig.at[d, k]
    return {
        "D1 주식80·금20":        (["SPY", "QQQ", "GLD"], lambda d: {"SPY": .4, "QQQ": .4, "GLD": .2}, "short", True),
        "D2 주식70·IEF15·금15":  (["SPY", "QQQ", "IEF", "GLD"], lambda d: {"SPY": .35, "QQQ": .35, "IEF": .15, "GLD": .15}, "short", True),
        "D3 주식80·단기채20":     (["SPY", "QQQ", "SHY"], lambda d: mix(.8, "SHY"), "short", True),
        "T1 추세·입금만":         (["SPY", "QQQ", "IEF"], lambda d: mix(1.0) if g(d, "trend") else {"IEF": 1.0}, "direct", False),
        "T2 추세·전환100↔50":     (["SPY", "QQQ", "IEF"], lambda d: mix(1.0) if g(d, "trend") else mix(.5), "short", True),
        "V1 변동성목표15%":       (["SPY", "QQQ", "IEF"], lambda d: mix(float(np.clip(.15 / g(d, "vol60"), .4, 1.0))), "short", True),
        "M1 듀얼모멘텀":          (["SPY", "QQQ", "IEF"], lambda d: mix(1.0) if g(d, "mom12") else {"IEF": 1.0}, "short", True),
    }

def frontier_delta(fr, m, final):
    """같은 최대낙폭의 고정 배분 대비 최종가치. 100% 주식보다 낙폭이 깊으면 100% 주식과 비교 (그보다 나을 수 없으므로)."""
    xs = np.array([p["mdd"] for p in fr]); ys = np.array([p["final"] for p in fr]); o = np.argsort(xs)
    if m < xs.min(): return final / ys[np.argmin(xs)] - 1
    if m > xs.max(): return np.nan
    return final / np.interp(m, xs[o], ys[o]) - 1

def fmt(name, s, base, extra=""):
    return (f"{name:22}{s['final'] / base['final']:>8.1%}{s['mdd']:>9.1%}{1 - s['mdd'] / base['mdd']:>8.0%}"
            f"{s['sharpe']:>7.2f}{s['expo']:>7.0%}{s['sold']:>8.0%}{extra}")

HEAD = f"{'':22}{'최종/100%':>8}{'최대낙폭':>8}{'낙폭감소':>7}{'샤프':>6}{'노출':>6}{'매도/입금':>7}"

def run(window, cal, px, sig):
    out = {}
    print(f"\n======== {window} {WINDOWS[window]} ========")
    fr = []
    for w in FRONTIER:
        df, sold, _ = simulate(cal, px, window, ["SPY", "QQQ", "IEF"], lambda d, w=w: mix(w), "short", True)
        fr.append(stats(df, sold))
    base = fr[0]
    print("\n[고정 배분 곡선: 주식·IEF, 입금 리밸런싱 + 10%p 밴드]"); print(HEAD)
    for w, s in zip(FRONTIER, fr): print(fmt(f"주식 {w:.0%}", s, base))
    print("\n[꾸준형 후보]  Δ = 같은 최대낙폭의 고정 배분 대비 최종가치"); print(HEAD + f"{'Δ':>8}")
    for name, (assets, fn, mode, sell) in steady_candidates(sig).items():
        df, sold, _ = simulate(cal, px, window, assets, fn, mode, sell); s = stats(df, sold)
        s["delta"] = frontier_delta(fr, s["mdd"], s["final"]); out[name] = s
        print(fmt(name, s, base, f"{s['delta']:>+8.1%}"))
    print("\n[수익형 후보]  대조 = 같은 평균 비중을 매달 고정으로"); print(HEAD + f"{'대조比':>8}{'낙폭차':>7}")
    g = lambda d, k: sig.at[d, k]
    L1, s1, t1 = simulate(cal, px, window, ["SPY", "QQQ", "SSO", "QLD"],
                          lambda d: {"SSO": .5, "QLD": .5} if g(d, "dd52") >= .10 else {"SPY": .5, "QQQ": .5}, "direct")
    f = float(np.mean([t.get("SSO", 0) + t.get("QLD", 0) for t in t1]))
    L0, s0, _ = simulate(cal, px, window, ["SPY", "QQQ", "SSO", "QLD"],
                         lambda d: {"SSO": f / 2, "QLD": f / 2, "SPY": (1 - f) / 2, "QQQ": (1 - f) / 2}, "direct")
    E_fn = lambda d: capped({t: (1 + g(d, f"score_{t}")) / 3 for t in ["SPY", "QQQ", "EFA"]})
    E1, _, te = simulate(cal, px, window, ["SPY", "QQQ", "EFA"], E_fn, "direct")
    avg = {t: float(np.mean([x[t] for x in te])) for t in ["SPY", "QQQ", "EFA"]}
    E0, _, _ = simulate(cal, px, window, ["SPY", "QQQ", "EFA"], lambda d: avg, "direct")
    for name, a, c, note in ((f"L1 하락시 입금→2배", L1, L0, f"  (2배 입금 비율 {f:.0%})"),
                             ("L0 대조(고정 2배 비율)", L0, None, ""),
                             ("E1 SPY·QQQ·EFA 하락가중", E1, E0, "  (평균 " + ", ".join(f"{k} {v:.0%}" for k, v in avg.items()) + ")"),
                             ("E0 대조(평균 비중 고정)", E0, None, "")):
        s = stats(a)
        if c is not None:
            sc = stats(c); s["vs"] = s["final"] / sc["final"] - 1; s["mdd_gap"] = s["mdd"] - sc["mdd"]; out[name] = s
            print(fmt(name, s, base, f"{s['vs']:>+8.1%}{s['mdd_gap']:>+7.1%}{note}"))
        else:
            print(fmt(name, s, base))
    return out

if __name__ == "__main__":
    cal, px = build(); sig = make_signals(px)
    res = {w: run(w, cal, px, sig) for w in WINDOWS}
    print("\n======== 선별 (결과 전 고정한 기준) ========")
    for name in res["pre"]:
        a, b = res["pre"][name], res["train"][name]
        if "delta" in a:
            ok = a["delta"] > 0 and b["delta"] > 0
            print(f"{name:22} Δ pre {a['delta']:+.1%} / train {b['delta']:+.1%} -> {'통과' if ok else '탈락'}")
        else:
            ok = a["vs"] > 0 and b["vs"] > 0 and a["mdd_gap"] > -.05 and b["mdd_gap"] > -.05
            print(f"{name:22} 대조比 pre {a['vs']:+.1%} / train {b['vs']:+.1%}, 낙폭차 {a['mdd_gap']:+.1%} / {b['mdd_gap']:+.1%} -> {'통과' if ok else '탈락'}")
