"""시장 현황판 생성. 공개 데이터(Yahoo S&P500, FRED)를 받아 dashboard/index.html 하나로 만든다.
매매 신호가 아니라 '지금 어떤 상황인지' 보는 용도. 백테스트 분석 코드(src/)와 데이터(data/)는 건드리지 않는다.
실행: python3 dashboard/build.py  (매달 다시 실행하면 갱신)"""
import io, json, time, datetime as dt, pathlib
import requests, pandas as pd

HERE = pathlib.Path(__file__).parent
SHOW_FROM = (pd.Timestamp.today() - pd.DateOffset(years=3)).normalize()

def get(url, **kw):
    for i in range(5):
        try:
            r = requests.get(url, timeout=30, **kw); r.raise_for_status(); return r
        except requests.RequestException:
            time.sleep(2 ** i)
    raise RuntimeError(url)

def yahoo(sym, start="2000-01-01"):
    p1 = int(dt.datetime.fromisoformat(start).replace(tzinfo=dt.timezone.utc).timestamp())
    res = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}", headers={"User-Agent": "Mozilla/5.0"},
              params=dict(period1=p1, period2=int(time.time()), interval="1d")).json()["chart"]["result"][0]
    s = pd.Series(res["indicators"]["quote"][0]["close"], index=pd.to_datetime(res["timestamp"], unit="s").normalize())
    return s.dropna()

def fred(sid, start="2015-01-01"):
    df = pd.read_csv(io.StringIO(get("https://fred.stlouisfed.org/graph/fredgraph.csv", params=dict(id=sid, cosd=start)).text))
    s = pd.Series(pd.to_numeric(df.iloc[:, 1], errors="coerce").values, index=pd.to_datetime(df.iloc[:, 0]))
    return s.dropna()

def pts(s, step=1):
    s = s[s.index >= SHOW_FROM]
    if step > 1: s = pd.concat([s.iloc[::step], s.iloc[[-1]]])
    s = s[~s.index.duplicated()]
    return [[d.strftime("%Y-%m-%d"), round(float(v), 3)] for d, v in s.items()]

def status(v, rules):
    """rules: [(조건함수, 등급, 라벨)] 처음 맞는 것."""
    for f, lvl, lab in rules:
        if f(v): return lvl, lab
    return "good", "정상"

spx = yahoo("^GSPC")
dd = spx / spx.cummax() - 1
ma200 = spx.rolling(200).mean()
gap = spx / ma200 - 1
ind = []

v = float(dd.iloc[-1]); lvl, lab = status(v, [(lambda x: x <= -.20, "critical", "약세장"), (lambda x: x <= -.10, "warning", "조정")])
ind.append(dict(id="dd", name="S&P500 고점 대비", unit="%", value=v * 100, level=lvl, label=lab, ref=[-10, -20],
                note="전고점에서 얼마나 내려왔는지. −10%면 조정, −20%면 약세장이라고 부릅니다.",
                series=[[d, round(x * 100, 2)] for d, x in pts(dd, 3)], date=dd.index[-1].strftime("%Y-%m-%d")))
v = float(gap.iloc[-1]); lvl, lab = status(v, [(lambda x: x < 0, "warning", "하락 추세")])
if lvl == "good": lab = "상승 추세"
ind.append(dict(id="ma", name="S&P500 200일선 대비", unit="%", value=v * 100, level=lvl, label=lab, ref=[0],
                note="200일 평균 가격보다 위면 상승 추세, 아래면 하락 추세. 신호가 늦고 오경보가 잦습니다.",
                series=[[d, round(x * 100, 2)] for d, x in pts(gap.dropna(), 3)], date=gap.index[-1].strftime("%Y-%m-%d")))

specs = [
    ("T10Y3M", "장단기 금리차 (10년−3개월)", "%p", [0], [(lambda x: x < 0, "warning", "역전")],
     "음수(역전)가 되면 1~2년 안에 경기침체가 온 적이 많았습니다. 시점은 들쭉날쭉합니다.", 3),
    ("T10Y2Y", "장단기 금리차 (10년−2년)", "%p", [0], [(lambda x: x < 0, "warning", "역전")],
     "위와 같은 성격. 역전이 풀리는(다시 양수가 되는) 시기에 침체가 시작된 경우가 많았습니다.", 3),
    ("SAHMREALTIME", "샴 룰 (실업률 상승폭)", "%p", [0.3, 0.5], [(lambda x: x >= .5, "critical", "침체 신호"), (lambda x: x >= .3, "warning", "주의")],
     "0.5 이상이면 경기침체가 이미 시작됐을 가능성이 큽니다. 늦지만 오경보가 적습니다.", 1),
    ("BAMLH0A0HYM2", "하이일드 신용 스프레드", "%p", [4.5, 6], [(lambda x: x >= 6, "critical", "위험"), (lambda x: x >= 4.5, "warning", "주의")],
     "위험한 회사채에 붙는 추가 금리. 금융 스트레스가 커지면 빠르게 올라갑니다.", 3),
    ("VIXCLS", "VIX 변동성 지수", "", [20, 30], [(lambda x: x >= 30, "critical", "공포"), (lambda x: x >= 20, "warning", "불안")],
     "시장이 예상하는 앞으로 한 달의 흔들림. 지금의 분위기를 보여줄 뿐 방향을 알려주지는 않습니다.", 3),
]
for sid, name, unit, ref, rules, note, step in specs:
    s = fred(sid); v = float(s.iloc[-1]); lvl, lab = status(v, rules)
    if lvl == "good" and ref == [0]: lab = "정상"
    if lvl == "good" and sid == "VIXCLS": lab = "평온"
    ind.append(dict(id=sid, name=name, unit=unit, value=v, level=lvl, label=lab, ref=ref, note=note,
                    series=pts(s, step), date=s.index[-1].strftime("%Y-%m-%d"), src=f"https://fred.stlouisfed.org/series/{sid}"))

by = {i["id"]: i for i in ind}
crit = [i for i in ind if i["level"] == "critical"]; warn = [i for i in ind if i["level"] == "warning"]
if by["dd"]["value"] <= -20 or by["SAHMREALTIME"]["value"] >= .5 or by["BAMLH0A0HYM2"]["value"] >= 6:
    regime = ("critical", "약세장 · 위기 경계")
elif crit or len(warn) >= 3 or by["dd"]["value"] <= -10:
    regime = ("warning", "조정 · 불안")
else:
    regime = ("good", "정상 · 상승 국면")
data = dict(updated=dt.date.today().isoformat(), regime=regime, n_warn=len(warn), n_crit=len(crit), indicators=ind,
            spx=dict(level=round(float(spx.iloc[-1]), 1), date=spx.index[-1].strftime("%Y-%m-%d")))
html = (HERE / "template.html").read_text().replace("/*__DATA__*/null", json.dumps(data, ensure_ascii=False))
(HERE / "index.html").write_text(html)
print("국면:", regime[1], "| 주의", len(warn), "위험", len(crit))
for i in ind: print(f"  {i['name']:24} {i['value']:8.2f}{i['unit']:3} {i['label']}  ({i['date']})")
