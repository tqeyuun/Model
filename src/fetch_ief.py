"""모델 5용 채권 ETF(IEF) 수집. fetch_data.py 와 같은 방식으로 raw/train/val/_sealed_test 에 분리 저장 (분석 코드는 _sealed_test를 읽지 않음)."""
import time, datetime as dt
import requests, pandas as pd

START = "2010-01-01"
SPLITS = {"train": ("2010-01-01", "2018-12-31"), "val": ("2019-01-01", "2022-12-31"), "_sealed_test": ("2023-01-01", "2100-01-01")}
p1 = int(dt.datetime.fromisoformat(START).replace(tzinfo=dt.timezone.utc).timestamp())
r = requests.get("https://query1.finance.yahoo.com/v8/finance/chart/IEF", headers={"User-Agent": "Mozilla/5.0"}, timeout=30,
                 params=dict(period1=p1, period2=int(time.time()), interval="1d", events="div,splits"))
r.raise_for_status(); res = r.json()["chart"]["result"][0]; q = res["indicators"]["quote"][0]
df = pd.DataFrame({"open": q["open"], "high": q["high"], "low": q["low"], "close": q["close"],
                   "adjclose": res["indicators"]["adjclose"][0]["adjclose"], "volume": q["volume"]},
                  index=pd.to_datetime(res["timestamp"], unit="s").normalize())
df.index.name = "date"
df.to_csv("data/raw/IEF.csv")
for k, (a, b) in SPLITS.items(): df.loc[a:b].to_csv(f"data/{k}/IEF.csv")
print(len(df), df.index[0], df.index[-1])
