"""분할매수(하락 매수) 백테스트. train/val 폴더만 읽는다 (_sealed_test 접근 금지)."""
import numpy as np, pandas as pd

WINDOWS = {"train": ("2010-01-01", "2018-12-31"), "val": ("2019-01-01", "2022-12-31")}
MAJOR, MINOR = ["SPY", "QQQ"], ["XLE", "XLF"]
BASE = dict(budget=1000.0, thr={"SPY": .05, "QQQ": .05, "XLE": .15, "XLF": .15},
            frac=1.0, fee=0.00075, xlf_rate_filter=True)

def load(t):
    d = pd.concat([pd.read_csv(f"data/{k}/{t}.csv", index_col=0, parse_dates=True) for k in ("train", "val")])
    f = d.adjclose / d.close
    return pd.DataFrame({"open": d.open * f, "close": d.adjclose})

def load_spread():
    r = pd.concat([pd.read_csv(f"data/{k}/rates.csv", index_col=0, parse_dates=True) for k in ("train", "val")])
    return r["spread_10y2y"]

def signals(px, thr, spread=None):
    """일자별 매수 신호(bool). 신호는 종가 기준, 체결은 다음날 시가."""
    c = px.close.values; n = len(c); sig = np.zeros(n, bool)
    peak = -np.inf; used = 0
    if spread is not None:  # 신호일 t에는 t-1까지의 금리만 사용
        sp = spread.ffill().reindex(px.index, method="ffill").shift(1).values
    for i in range(n):
        if c[i] >= peak: peak = c[i]; used = 0
        lvl = int((1 - c[i] / peak) / thr + 1e-12)
        if lvl > used:
            if spread is not None and not (sp[i] >= 0):  # 역전 또는 미확인 -> 보류
                continue
            sig[i] = True; used = lvl
    return sig

def run(px, sig, win, p, mode):
    """mode: 'dip' | 'dca'. 일별 시리즈(입금 D, 평가액 V, 현금, 주식수) 반환."""
    a, b = win; idx = px.index[(px.index >= a) & (px.index <= b)]
    pos0 = px.index.get_loc(idx[0])
    o, c = px.open.values, px.close.values
    cash = sh = spent = 0.0; nbuy = 0
    rows = []; prev_month = None
    for i in range(pos0, pos0 + len(idx)):
        dt = px.index[i]; D = 0.0
        if (dt.year, dt.month) != prev_month:
            prev_month = (dt.year, dt.month); D = p["budget"]; cash += D
            if mode == "dca":
                sh += cash * (1 - p["fee"]) / o[i]; spent += cash; cash = 0.0; nbuy += 1
        if mode == "dip" and i > 0 and sig[i - 1] and cash > 1.0:   # 어제 종가 신호 -> 오늘 시가 체결
            x = p["frac"] * cash
            sh += x * (1 - p["fee"]) / o[i]; spent += x; cash -= x; nbuy += 1
        rows.append((dt, D, sh * c[i] + cash, cash, sh))
    df = pd.DataFrame(rows, columns=["date", "D", "V", "cash", "sh"]).set_index("date")
    df["spent"] = np.nan
    return df, spent, nbuy

def irr(D, V_end):
    dates = D.index; t = ((dates - dates[0]).days / 365.25).values; cf = D.values
    T = (dates[-1] - dates[0]).days / 365.25
    f = lambda r: (cf * (1 + r) ** (T - t)).sum() - V_end
    lo, hi = -0.9, 5.0
    for _ in range(200):
        m = (lo + hi) / 2
        lo, hi = (lo, m) if f(m) > 0 else (m, hi)
    return (lo + hi) / 2

def metrics(df, spent, shares_total, nbuy):
    D, V = df.D, df.V
    ret = V / (V.shift(1, fill_value=0) + D) - 1
    nav = (1 + ret).cumprod(); mdd = (nav / nav.cummax() - 1).min()
    dep = D.sum()
    return dict(avg_price=spent / shares_total if shares_total else np.nan,
                total_return=V.iloc[-1] / dep - 1, irr=irr(D[D > 0], V.iloc[-1]), mdd=mdd,
                cash_ratio=(df.cash / V).mean(), buys=nbuy, deposits=dep, final=V.iloc[-1])

def backtest(window, p=None):
    p = {**BASE, **(p or {})}; sp = load_spread(); out = {}; series = {}
    for t in MAJOR + MINOR:
        px = load(t)
        s = signals(px, p["thr"][t], sp if (t == "XLF" and p["xlf_rate_filter"]) else None)
        for mode in ("dip", "dca"):
            df, spent, nb = run(px, s, WINDOWS[window], p, mode)
            series[(t, mode)] = (df, spent, nb)
            out[(t, mode)] = metrics(df, spent, df.sh.iloc[-1], nb)
    for name, group in (("주요", MAJOR), ("비주요", MINOR), ("합산", MAJOR + MINOR)):
        for mode in ("dip", "dca"):
            parts = [series[(t, mode)] for t in group]
            df = parts[0][0][["D", "V", "cash"]].copy()
            for q in parts[1:]: df = df + q[0][["D", "V", "cash"]]
            spent = sum(q[1] for q in parts); nb = sum(q[2] for q in parts)
            m = metrics(df, spent, 1, nb); m["avg_price"] = np.nan   # 합산 평균단가는 무의미
            out[(name, mode)] = m
    return out

def table(out, keys):
    rows = []
    for k in keys:
        for mode, lab in (("dip", "하락매수"), ("dca", "정액적립")):
            m = out[(k, mode)]
            rows.append([k, lab, m["avg_price"], m["total_return"], m["irr"], m["mdd"], m["cash_ratio"], m["buys"]])
    d = pd.DataFrame(rows, columns=["자산", "전략", "평균단가", "총수익률", "연환산IRR", "최대낙폭", "현금비율", "매수횟수"])
    return d.to_string(index=False, float_format=lambda x: f"{x:,.3f}")

if __name__ == "__main__":
    import sys
    for w in sys.argv[1:] or ["train"]:
        o = backtest(w); print(f"\n===== {w} =====")
        print(table(o, ["SPY", "QQQ", "XLE", "XLF", "주요", "비주요", "합산"]))
