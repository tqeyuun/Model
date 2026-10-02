"""최종 테스트(2023-01-01~). 사용자가 "최종 테스트 실행해줘"라고 명시적으로 말했을 때만 --confirm-final-test 로 실행.
--dry-run 은 봉인 데이터를 읽지 않고 검증 구간(2019~2022)으로 같은 코드 경로를 시험한다.
설정은 CONFIG_LOG.md / results/PREREGISTRATION.md 에 고정된 값 그대로이며, 이 스크립트는 설정을 바꾸지 않는다."""
import sys; sys.path.insert(0, "src")
import backtest as bt
from backtest import *

arg = sys.argv[1] if len(sys.argv) > 1 else ""
if arg == "--dry-run":
    window = "val"
elif arg == "--confirm-final-test":
    bt.FOLDERS = ("train", "val", "_sealed_test")
    bt.WINDOWS["test"] = ("2023-01-01", "2100-01-01"); window = "test"
else:
    sys.exit("최종 테스트는 사용자의 명시적 지시 후 --confirm-final-test 로만 실행. 시험용: --dry-run")

o = backtest(window); off = backtest(window, {"xlf_rate_filter": False})
print(f"===== {window} =====")
print(table(o, ["SPY", "QQQ", "XLE", "XLF", "주요", "비주요", "합산"]))
print("\n## 합격 기준 판정")
ok1 = {k: o[(k, 'dip')]['avg_price'] < o[(k, 'dca')]['avg_price'] for k in ("SPY", "QQQ", "XLE", "XLF")}
print("1. 평균 단가가 정액보다 낮음:", ", ".join(f"{k} {'O' if v else 'X'}" for k, v in ok1.items()), "=>", "O" if all(ok1.values()) else "X")
r2 = {k: o[(k, 'dip')]['total_return'] >= o[(k, 'dca')]['total_return'] for k in ("주요", "비주요", "합산")}
for k in r2: print(f"2. 총수익률 {k}: 하락 {o[(k,'dip')]['total_return']:+.3f} vs 정액 {o[(k,'dca')]['total_return']:+.3f} -> {'O' if r2[k] else 'X'}")
print("2. =>", "O" if all(r2.values()) else "X")
xo, xf = o[("XLF", "dip")]['total_return'], off[("XLF", "dip")]['total_return']
print(f"3. XLF 금리 조건 있음 {xo:+.3f} vs 없음 {xf:+.3f} -> {'O' if xo >= xf else 'X'}" + ("  (동일: 조건이 작동한 적 없으면 효과 검증 불가)" if xo == xf else ""))
n = o[("합산", 'dip')]['buys']; print(f"4. 전체 매수 {n}회 (>=20) -> {'O' if n >= 20 else 'X'}")
