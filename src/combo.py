"""세 계좌 합산 시뮬레이션 (코어-위성). data/explore/ (2018년까지)만 읽는다.
- 연금계좌: 모델 G (다자산 추세, 매도 세금 없음)
- 일반계좌 정액적립: 100% 주식(SPY·QQQ) 또는 주식 70 : IEF 30 (매도 거의 없음)
- 위성(개별주): 실제 종목 대신 가상의 미국 개별주 5종목. 각 종목 = 1.2 x SPY 일간수익률 + 고유 변동성 연 30% (평균 0).
  무작위 200회 반복해 중앙값(보통 운)과 하위 10%(나쁜 운)를 본다.
입금은 매달 1,000을 비중대로 나눠 각 계좌에 넣는다 (계좌 간 이동 없음).
"""
import sys
import numpy as np, pandas as pd
sys.path.insert(0, "src")
import explore3 as e
import explore4 as g

SEEDS, N_STOCK, BETA, IDIO = 200, 5, 1.2, 0.30
WINS = {"2005~09": "pre", "2010~18": "train", "2005~18": ("2005-01-01", "2018-12-31")}

def sleeves(cal, px, on, win):
    """계좌별 시리즈 (입금 1,000 기준). 위성은 무작위 시드별 목록."""
    G = e.simulate(cal, px, win, g.ASSETS + ["SHY"], g.g_fn(on), "short", True)[0]
    S100 = e.simulate(cal, px, win, ["SPY", "QQQ", "IEF"], lambda d: e.mix(1.0), "short", True)[0]
    S70 = e.simulate(cal, px, win, ["SPY", "QQQ", "IEF"], lambda d: e.mix(.7), "short", True)[0]
    rng = np.random.default_rng(0); r = px["SPY"].close.pct_change().fillna(0).values
    on_ = (px["SPY"].open / px["SPY"].close.shift(1) - 1).fillna(0).values
    sats = []
    for _ in range(SEEDS):
        names = []
        for k in range(N_STOCK):
            eps = rng.normal(0, IDIO / np.sqrt(252), len(r))
            close = 100 * np.cumprod(1 + BETA * r + eps)
            opn = np.r_[100.0, close[:-1] * (1 + BETA * on_[1:])]
            px[f"S{k}"] = pd.DataFrame({"open": opn, "close": close}, index=cal); names.append(f"S{k}")
        sats.append(e.simulate(cal, px, win, names, lambda d: {n: 1 / N_STOCK for n in names}, "direct")[0])
    return {"G": G, "주식100": S100, "주식70": S70}, sats

def combine(parts):
    """[(비중, 시리즈)] -> 합산 시리즈 (입금 1,000)."""
    D = sum(w * s.D for w, s in parts); V = sum(w * s.V for w, s in parts)
    return pd.DataFrame({"D": D, "V": V, "expo": 0.0})

def worst(df): return (df.V / df.D.cumsum() - 1).min()

COMBOS = [   # (이름, 연금 G, 정액적립 종류, 정액 비중, 위성 비중)
    ("기준: 100% 주식 정액적립", 0.0, "주식100", 1.0, 0.0),
    ("연금 G 50 / 주식 50", .5, "주식100", .5, 0.0),
    ("연금 G 50 / 주식 35 / 개별주 15", .5, "주식100", .35, .15),
    ("연금 G 50 / 70:30 35 / 개별주 15", .5, "주식70", .35, .15),
    ("연금 G 35 / 주식 50 / 개별주 15", .35, "주식100", .5, .15),
]

if __name__ == "__main__":
    cal, px, on = g.build()
    for label, win in WINS.items():
        sl, sats = sleeves(cal, px, on, win)
        base = e.stats(sl["주식100"])
        print(f"\n===== {label} =====  (위성 있는 조합은 무작위 {SEEDS}회 중앙값 [하위 10%])")
        print(f"{'':34}{'최종/기준':>10}{'최대낙폭':>16}{'원금대비 최대손실':>18}")
        for name, wg, core, wc, ws in COMBOS:
            res = []
            for s in (sats if ws else [None]):
                parts = [(wg, sl["G"]), (wc, sl[core])] + ([(ws, s)] if ws else [])
                df = combine([p for p in parts if p[0] > 0]); st = e.stats(df)
                res.append((st["final"] / base["final"], st["mdd"], worst(df)))
            a = np.array(res)
            if ws:
                q = lambda i, p: np.percentile(a[:, i], p)
                print(f"{name:34}{q(0, 50):>9.0%} [{q(0, 10):.0%}]{q(1, 50):>9.1%} [{q(1, 10):.1%}]{q(2, 50):>9.0%} [{q(2, 10):.0%}]")
            else:
                print(f"{name:34}{a[0, 0]:>9.0%}{a[0, 1]:>16.1%}{a[0, 2]:>17.0%}")
