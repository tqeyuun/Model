"""combo.py 세후 환산 (2005~18, 위성 제외 조합): 연금 세액공제 13.2% 재투자·수령세 5.5%, 일반계좌는 끝에 전부 팔 때 이익의 22% (공제 무시, 보수적)."""
import sys
sys.path.insert(0, "src")
import explore3 as e, explore4 as g
cal, px, on = g.build(); win = ("2005-01-01", "2018-12-31")
G = e.simulate(cal, px, win, g.ASSETS + ["SHY"], g.g_fn(on), "short", True)[0]
S = {w: e.simulate(cal, px, win, ["SPY", "QQQ", "IEF"], lambda d, w=w: e.mix(w), "short", True)[0] for w in (1.0, .7)}
pen = lambda wt: wt * G.V.iloc[-1] * 1.132 * (1 - .055)
gen = lambda wt, s: wt * (s.V.iloc[-1] - .22 * (s.V.iloc[-1] - s.D.sum()))
rows = [("100% 주식 정액적립 (일반계좌)", gen(1, S[1.0])),
        ("연금 G 50 / 주식 50", pen(.5) + gen(.5, S[1.0])),
        ("연금 G 50 / 70:30 50", pen(.5) + gen(.5, S[.7])),
        ("연금에 주식 100% 50 / 주식 50 (G 없이 계좌만)", .5 * S[1.0].V.iloc[-1] * 1.132 * .945 + gen(.5, S[1.0]))]
b = rows[0][1]
for n, v in rows: print(f"{n:42} 세후 {v:>9,.0f}  기준 대비 {v / b:.0%}")
