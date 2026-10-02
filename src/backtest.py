"""분할매수(하락 매수) 백테스트. train/val 폴더만 읽는다 (_sealed_test 접근 금지)."""
import numpy as np, pandas as pd

FOLDERS = ("train", "val")   # 최종 테스트 스크립트만 _sealed_test를 추가한다
WINDOWS = {"train": ("2010-01-01", "2018-12-31"), "val": ("2019-01-01", "2022-12-31")}
MAJOR, MINOR = ["SPY", "QQQ"], ["XLE", "XLF"]
BASE = dict(budget=1000.0, thr={"SPY": .05, "QQQ": .05, "XLE": .15, "XLF": .15},
            amount=1000.0, fee=0.00075, xlf_rate_filter=True, cash_yield=True, scale=False)

def load(t):
    d = pd.concat([pd.read_csv(f"data/{k}/{t}.csv", index_col=0, parse_dates=True) for k in FOLDERS])
    f = d.adjclose / d.close
    return pd.DataFrame({"open": d.open * f, "close": d.adjclose})

def load_spread():
    r = pd.concat([pd.read_csv(f"data/{k}/rates.csv", index_col=0, parse_dates=True) for k in FOLDERS])
    return r["spread_10y2y"]

def load_cash_rate():
    r = pd.concat([pd.read_csv(f"data/{k}/rates.csv", index_col=0, parse_dates=True) for k in FOLDERS])
    return r["DGS2"].ffill() / 100.0   # 연율, 단기 국채 금리를 현금 수익률 대용으로 사용

def signals(px, thr, spread=None):
    """일자별 매수 신호(bool). 신호는 종가 기준, 체결은 다음날 시가."""
    c = px.close.values; n = len(c); sig = np.zeros(n, int)
    peak = -np.inf; used = 0
    if spread is not None:  # 신호일 t에는 t-1까지의 금리만 사용
        sp = spread.ffill().reindex(px.index, method="ffill").shift(1).values
    for i in range(n):
        if c[i] >= peak: peak = c[i]; used = 0
        lvl = int((1 - c[i] / peak) / thr + 1e-12)
        if lvl > used:
            if spread is not None and not (sp[i] >= 0):  # 역전 또는 미확인 -> 보류
                continue
            sig[i] = lvl; used = lvl
    return sig

def run(px, sig, win, p, mode, rate=None):
    """mode: 'dip' | 'dca'. 일별 시리즈(입금 D, 평가액 V, 현금, 주식수) 반환."""
    a, b = win; idx = px.index[(px.index >= a) & (px.index <= b)]
    pos0 = px.index.get_loc(idx[0])
    o, c = px.open.values, px.close.values
    cash = sh = spent = 0.0; nbuy = 0
    rows = []; prev_month = None
    for i in range(pos0, pos0 + len(idx)):
        dt = px.index[i]; D = 0.0; x = 0.0
        if rate is not None and i > 0:   # 전일까지 알려진 금리로 보유 현금에 일할 이자
            cash *= 1 + rate[i] * (dt - px.index[i - 1]).days / 365
        if (dt.year, dt.month) != prev_month:
            prev_month = (dt.year, dt.month); D = p["budget"]; cash += D
            if mode == "dca":
                sh += cash * (1 - p["fee"]) / o[i]; spent += cash; cash = 0.0; nbuy += 1
        if mode == "dip" and i > 0 and sig[i - 1] and cash > 1.0:   # 어제 종가 신호 -> 오늘 시가 체결
            x = min(p["amount"] * (sig[i - 1] if p["scale"] else 1), cash)   # 계획: 회당 고정 금액 (잔고 부족 시 잔고만큼)
            sh += x * (1 - p["fee"]) / o[i]; spent += x; cash -= x; nbuy += 1
        rows.append((dt, D, sh * c[i] + cash, cash, sh, x if mode == "dip" else D))
    df = pd.DataFrame(rows, columns=["date", "D", "V", "cash", "sh", "buy"]).set_index("date")
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
    den = V.shift(1, fill_value=0) + D
    ret = (V / den.where(den > 0) - 1).fillna(0.0)
    nav = (1 + ret).cumprod(); mdd = (nav / nav.cummax() - 1).min()
    dep = D.sum()
    return dict(avg_price=spent / shares_total if shares_total else np.nan,
                total_return=V.iloc[-1] / dep - 1, irr=irr(D[D > 0], V.iloc[-1]), mdd=mdd,
                cash_ratio=(df.cash / V).mean(), buys=nbuy, deposits=dep, final=V.iloc[-1])

def backtest(window, p=None):
    p = {**BASE, **(p or {})}; sp = load_spread(); cr = load_cash_rate(); out = {}; series = {}
    for t in MAJOR + MINOR:
        px = load(t)
        s = signals(px, p["thr"][t], sp if (t == "XLF" and p["xlf_rate_filter"]) else None)
        rate = cr.reindex(px.index, method="ffill").shift(1).fillna(0).values if p["cash_yield"] else None
        for mode in ("dip", "dca"):
            df, spent, nb = run(px, s, WINDOWS[window], p, mode, rate)
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


def backtest_matched(window, p=None):
    """A 방식: 하락매수가 실제 투입한 금액 S를, 정액적립이 같은 기간에 매달 균등하게(S/개월수) 투입. 투입 자본 기준 비교."""
    p = {**BASE, **(p or {})}; sp = load_spread(); cr = load_cash_rate(); out = {}; ser = {}
    for t in MAJOR + MINOR:
        px = load(t)
        sg = signals(px, p["thr"][t], sp if (t == "XLF" and p["xlf_rate_filter"]) else None)
        rate = cr.reindex(px.index, method="ffill").shift(1).fillna(0).values if p["cash_yield"] else None
        dip, S, nb = run(px, sg, WINDOWS[window], p, "dip", rate)
        nm = int((dip.D > 0).sum())
        dca, S2, nb2 = run(px, sg, WINDOWS[window], {**p, "budget": S / nm}, "dca", None)
        A = pd.DataFrame({"D": dip.buy, "V": dip.V - dip.cash, "cash": 0.0})
        B = dca[["D", "V", "cash"]]
        ser[t] = (A, B, S, S2, nb, nb2, dip, dca)
        out[(t, "dip")] = {**metrics(A, S, dip.sh.iloc[-1], nb), "invested": S, "cash_ratio_full": (dip.cash / dip.V).mean()}
        out[(t, "dca")] = {**metrics(B, S2, dca.sh.iloc[-1], nb2), "invested": S2, "cash_ratio_full": 0.0}
    for name, group in (("주요", MAJOR), ("비주요", MINOR), ("합산", MAJOR + MINOR)):
        for k, idx in (("dip", 0), ("dca", 1)):
            df = ser[group[0]][idx].copy()
            for g in group[1:]: df = df + ser[g][idx]
            S = sum(ser[g][2 + idx] for g in group); nb = sum(ser[g][4 + idx] for g in group)
            m = metrics(df, S, 1, nb); m["avg_price"] = np.nan; m["invested"] = S
            full = sum(ser[g][6][c] for g in group for c in ["cash"]); tot = sum(ser[g][6]["V"] for g in group)
            m["cash_ratio_full"] = (full / tot).mean() if k == "dip" else 0.0
            out[(name, k)] = m
    return out

def table_matched(o, keys):
    rows = []
    for k in keys:
        for mode, lab in (("dip", "하락매수"), ("dca", "동일자본 정액")):
            m = o[(k, mode)]
            rows.append([k, lab, m["avg_price"], m["invested"], m["total_return"], m["irr"], m["mdd"], m["buys"]])
    return pd.DataFrame(rows, columns=["자산", "전략", "평균단가", "투입금", "투입자본수익률", "IRR", "최대낙폭", "매수횟수"]).to_string(index=False, float_format=lambda x: f"{x:,.3f}")
