"""모델 5: 주식·채권 배분 + 입금 리밸런싱. train/val 폴더만 읽는다 (_sealed_test 접근 금지).
결정은 전일 종가 기준, 체결은 당일 시가, 편도 비용 0.075%. 주식 = SPY·QQQ 반반, 채권 = IEF.
"""
import sys
import numpy as np, pandas as pd
sys.path.insert(0, "src")
from backtest import load, WINDOWS, BASE
from model1 import stats

DEPOSIT, FEE, BAND = 1000.0, BASE["fee"], 0.10
DIP_TRIGGER, DIP_BOOST = 0.20, 0.10
COMBOS = {  # 사전 등록 조합: (기본 주식 비중, 하락 강화)
    "5-A": (0.80, False), "5-B": (0.90, False), "5-C": (0.80, True), "5-D": (0.90, True),
}
ASSETS = ["SPY", "QQQ", "IEF"]

def stock_drawdown(px):
    """주식 sleeve(SPY·QQQ 일별 균등 혼합 지수)의 전고점 대비 하락률, 날짜별(종가 기준)."""
    r = (px["SPY"].close.pct_change().fillna(0) + px["QQQ"].close.pct_change().fillna(0)) / 2
    idx = (1 + r).cumprod()
    return 1 - idx / idx.cummax()

def simulate(px, window, stock_w, boost=False, bond=True, rebalance=True):
    a, b = WINDOWS[window]
    days = px["SPY"].index; days = days[(days >= a) & (days <= b)]
    dd = stock_drawdown(px); sh = {t: 0.0 for t in ASSETS}
    rows = []; prev_m = None; boosted = False; sells = 0.0; nsell = 0
    for dt in days:
        i = px["SPY"].index.get_loc(dt); pd_ = px["SPY"].index[i - 1]
        o = {t: px[t].open.loc[dt] for t in ASSETS}; pc = {t: px[t].close.loc[pd_] for t in ASSETS}
        # 목표 비중 (전일 종가 기준 상태)
        sw = stock_w; switched = False
        if boost:
            if not boosted and dd.loc[pd_] > DIP_TRIGGER: boosted = True; switched = True
            elif boosted and dd.loc[pd_] <= 1e-9: boosted = False; switched = True
            if boosted: sw = min(1.0, stock_w + DIP_BOOST)
        tgt = {"SPY": sw / 2, "QQQ": sw / 2, "IEF": 1 - sw} if bond else {"SPY": .5, "QQQ": .5, "IEF": 0.0}
        hold = {t: sh[t] * pc[t] for t in ASSETS}; V = sum(hold.values())
        D = 0.0
        if (dt.year, dt.month) != prev_m: prev_m = (dt.year, dt.month); D = DEPOSIT
        # 1) 매도 리밸런싱: 밴드 이탈 또는 목표 전환 시 (전체를 목표로)
        sdev = (hold["SPY"] + hold["QQQ"]) / V - sw if V > 0 else 0.0
        if rebalance and V > 0 and (abs(sdev) > BAND + 1e-12 or switched):
            tot = V + D
            for t in ASSETS:                      # 매도
                need = tgt[t] * tot - hold[t]
                if need < 0:
                    s = -need / pc[t]; sh[t] -= s; D += s * o[t] * (1 - FEE); sells += s * o[t]; nsell += 1
            # 매도 대금 + 입금은 부족분에 배분
            hold = {t: sh[t] * pc[t] for t in ASSETS}
        # 2) 입금(및 매도 대금) 리밸런싱: 모자란 쪽부터
        if D > 0:
            tot = sum(hold.values()) + D
            short = {t: max(0.0, tgt[t] * tot - hold[t]) for t in ASSETS}; S = sum(short.values())
            alloc = {t: (D * short[t] / S if S >= D else short[t] + (D - S) * tgt[t]) for t in ASSETS} if S > 0 else {t: D * tgt[t] for t in ASSETS}
            for t in ASSETS:
                if alloc[t] > 0: sh[t] += alloc[t] * (1 - FEE) / o[t]
        rows.append((dt, None, sum(sh[t] * px[t].close.loc[dt] for t in ASSETS)))
    return rows, nsell

def run(px, window, stock_w, boost=False, bond=True, rebalance=True):
    days = px["SPY"].index; a, b = WINDOWS[window]; days = days[(days >= a) & (days <= b)]
    rows, nsell = simulate(px, window, stock_w, boost, bond, rebalance)
    df = pd.DataFrame(rows, columns=["date", "D", "V"]).set_index("date")
    dep = pd.Series(0.0, index=df.index); first = pd.Series(df.index.to_period("M"), index=df.index).drop_duplicates().index
    dep.loc[first] = DEPOSIT; df["D"] = dep
    return df, nsell

def nav_of(df):
    den = df.V.shift(1, fill_value=0) + df.D
    return (1 + (df.V / den.where(den > 0) - 1).fillna(0.0)).cumprod()

def report(window):
    px = {t: load(t) for t in ASSETS}
    base, _ = run(px, window, 1.0, bond=False, rebalance=False)   # 100% 주식 정액적립 (SPY·QQQ 반반)
    sb = stats(base); print(f"\n===== {window} {WINDOWS[window]} =====")
    print(f"{'':22}{'최종가치':>10}{'총수익률':>9}{'최대낙폭':>9}{'샤프':>6}{'2022':>8}{'매도':>5}")
    nb = nav_of(base)
    def row(lab, df, ns):
        s = stats(df); y = s["yearly"].get(2022, np.nan)
        print(f"{lab:22}{s['final']:>10,.0f}{s['total_return']:>9.1%}{s['mdd']:>9.1%}{s['sharpe']:>6.2f}{y:>8.1%}{ns:>5}")
        return s
    row("100% 주식 정액적립", base, 0); res = {}
    for name, (w, boost) in COMBOS.items():
        df, ns = run(px, window, w, boost); s = row(f"{name} {w:.0%}:{1-w:.0%}{' +강화' if boost else ''}", df, ns)
        ok = (abs(s["mdd"]) <= 0.7 * abs(sb["mdd"]) and s["sharpe"] >= sb["sharpe"] and s["final"] >= 0.9 * sb["final"])
        print(f"{'':22}낙폭 감소 {1-abs(s['mdd'])/abs(sb['mdd']):.0%}(≥30%) 샤프 {'≥' if s['sharpe']>=sb['sharpe'] else '<'} 최종가치 {s['final']/sb['final']:.0%}(≥90%) -> {'충족' if ok else '미달'}")
        res[name] = ok
    return res

if __name__ == "__main__":
    for w in sys.argv[1:] or ["train", "val"]: report(w)
