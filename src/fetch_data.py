"""1단계: 데이터 수집. 원본 -> 구간별 분리 저장.
최종 테스트(2023-01-01~)는 data/_sealed_test/ 에 저장만 하고 분석 코드는 읽지 않는다."""
import io, time, datetime as dt
import requests, pandas as pd

TICKERS = ["SPY", "QQQ", "XLE", "XLF"]
FRED = ["DGS10", "DGS2"]
START = "2010-01-01"
SPLITS = {"train": ("2010-01-01", "2018-12-31"),
          "val": ("2019-01-01", "2022-12-31"),
          "_sealed_test": ("2023-01-01", "2100-01-01")}
ROOT = "data"
UA = {"User-Agent": "Mozilla/5.0"}

def get(url, headers=UA, **kw):
    for i in range(5):
        try:
            r = requests.get(url, headers=headers, timeout=30, **kw); r.raise_for_status(); return r
        except requests.RequestException as e:
            print("retry", i, type(e).__name__); time.sleep(2 ** i)
    raise RuntimeError(f"failed: {url}")

def yahoo(t):
    p1 = int(dt.datetime.fromisoformat(START).replace(tzinfo=dt.timezone.utc).timestamp())
    p2 = int(time.time())
    r = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{t}",
        params=dict(period1=p1, period2=p2, interval="1d", events="div,splits"))
    res = r.json()["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    df = pd.DataFrame({"open": q["open"], "high": q["high"], "low": q["low"], "close": q["close"],
                       "adjclose": res["indicators"]["adjclose"][0]["adjclose"], "volume": q["volume"]},
                      index=pd.to_datetime(res["timestamp"], unit="s").normalize())
    df.index.name = "date"
    return df

def fred(s):
    r = get("https://fred.stlouisfed.org/graph/fredgraph.csv", params=dict(id=s, cosd=START), headers=None)
    df = pd.read_csv(io.StringIO(r.text))
    df.columns = ["date", s]
    df["date"] = pd.to_datetime(df["date"])
    df[s] = pd.to_numeric(df[s], errors="coerce")  # '.' = 휴장일 결측
    return df.set_index("date")

def save_split(name, df):
    df.to_csv(f"{ROOT}/raw/{name}.csv")
    for k, (a, b) in SPLITS.items():
        df.loc[a:b].to_csv(f"{ROOT}/{k}/{name}.csv")

import os
for t in TICKERS:
    if not os.path.exists(f"{ROOT}/raw/{t}.csv"):
        save_split(t, yahoo(t))
rates = pd.concat([fred(s) for s in FRED], axis=1)
rates["spread_10y2y"] = rates["DGS10"] - rates["DGS2"]
save_split("rates", rates)
print("done")
