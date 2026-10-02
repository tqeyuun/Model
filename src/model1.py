"""모델 1: 하락 가중 배분 적립 (현금 0%). train/val 폴더만 읽는다 (_sealed_test 접근 금지).
매달 첫 거래일, 전일 종가까지의 정보로 배분 -> 당일 시가에 전액 매수 (비용 편도 0.075%).
"""
import sys
import numpy as np, pandas as pd
sys.path.insert(0, "src")
from backtest import load, WINDOWS, BASE

DEPOSIT, FEE, CAP, SECTOR_CAP = 1000.0, BASE["fee"], 0.70, 0.20
VOL_WIN, VOL_MIN = 252, 20
COMBOS = {  # 사전 등록 조합
    "1-A": dict(assets=["SPY", "QQQ"], k=1.0),
    "1-B": dict(assets=["SPY", "QQQ"], k=0.5),
    "1-C": dict(assets=["SPY", "QQQ"], k=2.0),
    "1-D": dict(assets=["SPY", "QQQ", "XLE", "XLF"], k=1.0),
}
SECTORS = {"XLE", "XLF"}

def base_weights(assets):
    """균등 비중. 섹터 포함 조합은 섹터 합계 20%(각 10%), 나머지를 주요 자산에 균등 배분."""
    sec = [a for a in assets if a in SECTORS]; maj = [a for a in assets if a not in SECTORS]
    w = {a: (1 - SECTOR_CAP * bool(sec)) / len(maj) for a in maj}
    w.update({a: SECTOR_CAP / len(sec) for a in sec})
    return w

def cap_weights(w):
    """자산당 상한 70% (초과분은 나머지에 비례 재배분), 섹터 합계 20% 이하."""
    w = dict(w)
    for _ in range(20):
        sec = sum(v for a, v in w.items() if a in SECTORS)
        if sec > SECTOR_CAP + 1e-12:
            f = SECTOR_CAP / sec
            for a in w:
                if a in SECTORS: w[a] *= f
            fr = [a for a in w if a not in SECTORS]; rest = 1 - sum(w[a] for a in w if a in SECTORS)
            s = sum(w[a] for a in fr)
            for a in fr: w[a] *= rest / s
        over = [a for a in w if w[a] > CAP + 1e-12]
        if not over and sum(v for a, v in w.items() if a in SECTORS) <= SECTOR_CAP + 1e-12: break
        for a in over:
            ex = w[a] - CAP; w[a] = CAP
            others = [b for b in w if b != a and w[b] < CAP and not (b in SECTORS)]
            s = sum(w[b] for b in others)
            for b in others: w[b] += ex * w[b] / s
    return w

def drop_scores(px):
    """하락 점수 = 전고점 대비 하락률 / 평소 변동성(직전 252일 일간수익률 표준편차 x sqrt(252)). 날짜 t의 값은 t 종가 기준."""
    c = px.close
    dd = 1 - c / c.cummax()
    vol = c.pct_change().rolling(VOL_WIN, min_periods=VOL_MIN).std() * np.sqrt(252)
    return (dd / vol).fillna(0.0)

def allocate(scores, base, k):
    w = cap_weights({a: base[a] * (1 + k * scores[a]) for a in base})
    s = sum(w.values()); return cap_weights({a: v / s for a, v in w.items()})

def simulate(px, assets, window, weight_fn):
    """월 첫 거래일에 전액 매수. weight_fn(prev_date) -> {asset: weight}. 일별 평가액 시리즈와 사용 비중 반환."""
    a, b = WINDOWS[window]
    idx = px[assets[0]].index[(px[assets[0]].index >= a) & (px[assets[0]].index <= b)]
    sh = {t: 0.0 for t in assets}; rows = []; used = []; prev = None
    for dt in idx:
        D = 0.0
        if (dt.year, dt.month) != prev:
            prev = (dt.year, dt.month); D = DEPOSIT
            i = px[assets[0]].index.get_loc(dt)
            pdt = px[assets[0]].index[i - 1] if i > 0 else None   # 데이터 첫날은 전일 정보 없음 (index[-1] 순환 방지)
            w = weight_fn(pdt); used.append(w)
            for t in assets: sh[t] += D * w[t] * (1 - FEE) / px[t].open.loc[dt]
        rows.append((dt, D, sum(sh[t] * px[t].close.loc[dt] for t in assets)))
    return pd.DataFrame(rows, columns=["date", "D", "V"]).set_index("date"), used

def stats(df):
    den = df.V.shift(1, fill_value=0) + df.D
    ret = (df.V / den.where(den > 0) - 1).fillna(0.0)
    nav = (1 + ret).cumprod()
    yearly = nav.groupby(nav.index.year).last()
    yr = yearly / yearly.shift(1).fillna(1.0) - 1   # 연도별 시간가중 수익률
    return dict(final=df.V.iloc[-1], total_return=df.V.iloc[-1] / df.D.sum() - 1,
                mdd=(nav / nav.cummax() - 1).min(), sharpe=ret.mean() / ret.std() * np.sqrt(252), yearly=yr)

def run_window(window):
    out = {}
    for name, cfg in COMBOS.items():
        assets, k = cfg["assets"], cfg["k"]
        px = {t: load(t) for t in assets}; sc = {t: drop_scores(px[t]) for t in assets}
        base = base_weights(assets)
        m1, used = simulate(px, assets, window, lambda d: allocate({t: sc[t].get(d, 0.0) for t in assets}, base, k))
        avg = {t: float(np.mean([u[t] for u in used])) for t in assets}
        eq, _ = simulate(px, assets, window, lambda d: base)
        fx, _ = simulate(px, assets, window, lambda d: avg)
        S = {"모델1": stats(m1), "기준①": stats(eq), "기준②": stats(fx)}
        out[name] = dict(S=S, avg=avg, k=k)
    return out

def report(window):
    res = run_window(window); print(f"\n===== {window} {WINDOWS[window]} =====")
    for name, r in res.items():
        S = r["S"]; print(f"\n[{name}] 자산={list(r['avg'])} k={r['k']}  평균비중=" + ", ".join(f"{t} {v:.1%}" for t, v in r["avg"].items()))
        print(f"{'':6}{'최종가치':>10}{'총수익률':>9}{'최대낙폭':>9}{'샤프':>6}")
        for lab, s in S.items(): print(f"{lab:6}{s['final']:>10,.0f}{s['total_return']:>9.1%}{s['mdd']:>9.1%}{s['sharpe']:>6.2f}")
        y = S["모델1"]["yearly"]
        w1 = (y > S["기준①"]["yearly"]).mean(); w2 = (y > S["기준②"]["yearly"]).mean()
        ok = (S["모델1"]["final"] > S["기준①"]["final"] and S["모델1"]["final"] > S["기준②"]["final"]
              and w1 > .5 and S["모델1"]["mdd"] >= S["기준①"]["mdd"] - 0.05)
        print(f"연도별 우위 ①{w1:.0%} ②{w2:.0%} | 낙폭차(모델-①) {S['모델1']['mdd']-S['기준①']['mdd']:+.1%} | 합격기준 {'충족' if ok else '미달'}")
    return res

if __name__ == "__main__":
    for w in sys.argv[1:] or ["train", "val"]: report(w)
