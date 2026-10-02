"""전략 3 탐색용 데이터. 2018-12-31 이전 행만 받아 data/explore/ 에 저장한다.
검증(2019~2022)·최종 테스트(2023~) 구간은 요청 범위에서 빼므로 받지도 저장하지도 않는다."""
import io, os, time, datetime as dt
import requests, pandas as pd

TICKERS = ["SPY", "QQQ", "IEF", "SHY", "GLD", "EFA"]
START, END = "2000-01-01", "2019-01-01"   # END 미포함
OUT = "data/explore"

def ts(s): return int(dt.datetime.fromisoformat(s).replace(tzinfo=dt.timezone.utc).timestamp())

def get(url, **kw):
    for i in range(5):
        try:
            r = requests.get(url, timeout=30, **kw); r.raise_for_status(); return r
        except requests.RequestException as e:
            print("retry", i, type(e).__name__); time.sleep(2 ** i)
    raise RuntimeError(f"failed: {url}")

def yahoo(t):
    r = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{t}", headers={"User-Agent": "Mozilla/5.0"},
            params=dict(period1=ts(START), period2=ts(END), interval="1d", events="div,splits"))
    res = r.json()["chart"]["result"][0]; q = res["indicators"]["quote"][0]
    df = pd.DataFrame({"open": q["open"], "high": q["high"], "low": q["low"], "close": q["close"],
                       "adjclose": res["indicators"]["adjclose"][0]["adjclose"], "volume": q["volume"]},
                      index=pd.to_datetime(res["timestamp"], unit="s").normalize())
    df.index.name = "date"
    return df[df.index < END]

def fred(s):
    r = get("https://fred.stlouisfed.org/graph/fredgraph.csv", params=dict(id=s, cosd=START, coed="2018-12-31"))
    df = pd.read_csv(io.StringIO(r.text)); df.columns = ["date", s]
    df["date"] = pd.to_datetime(df["date"]); df[s] = pd.to_numeric(df[s], errors="coerce")
    return df.set_index("date")

os.makedirs(OUT, exist_ok=True)
for t in TICKERS:
    df = yahoo(t); df.to_csv(f"{OUT}/{t}.csv")
    print(t, df.index[0].date(), df.index[-1].date(), len(df), "결측행", int(df.isna().any(axis=1).sum()))
r = fred("DTB3"); r = r[r.index < END]; r.to_csv(f"{OUT}/rates.csv")   # 3개월 국채 금리: 합성 2배 ETF 차입 비용
print("DTB3", r.index[0].date(), r.index[-1].date())
