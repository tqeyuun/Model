"""3단계: 확정 설정(v0', 변경 3/5 중 채택 0건)의 비용 민감도 + 합격 기준 사전 점검. train/val만 사용."""
import sys; sys.path.insert(0, "src")
from backtest import *

lines = []
def out(s=""): print(s); lines.append(s)

out("# 3단계 결과 요약 (학습·검증만, 최종 테스트 미실행)\n")
out("확정 설정: 회당 1,000 고정 / 주요 -5% / 비주요 -15% / 월 입금 자산당 1,000 / 다음날 시가 체결 / 현금 수익률 0%. 설정 변경 3/5 (채택 0건, 시도 3건 중 되돌림 2건 + 폐기 1건).\n")

out("## 1. 비용 민감도 (편도)")
out("| 구간 | 비용 | 주요 하락 | 주요 정액 | 비주요 하락 | 비주요 정액 | 합산 하락 | 합산 정액 |")
out("|---|---|---|---|---|---|---|---|")
for w in ("train", "val"):
    for fee in (0.0005, 0.00075, 0.001):
        o = backtest(w, {"fee": fee}); r = lambda k, m: f"{o[(k, m)]['total_return']:+.3f}"
        out(f"| {w} | {fee*100:.3f}% | {r('주요','dip')} | {r('주요','dca')} | {r('비주요','dip')} | {r('비주요','dca')} | {r('합산','dip')} | {r('합산','dca')} |")
out("\n(총수익률 = 최종 평가액 / 총 입금액 - 1)\n")

out("## 2. 합격 기준 사전 점검 (정식 판정은 최종 테스트에서만)")
for w in ("train", "val"):
    o = backtest(w); off = backtest(w, {"xlf_rate_filter": False})
    out(f"\n### {w}")
    p1 = {k: o[(k, 'dip')]['avg_price'] < o[(k, 'dca')]['avg_price'] for k in ("SPY", "QQQ", "XLE", "XLF")}
    out(f"1. 평균 단가가 정액보다 낮음: " + ", ".join(f"{k} {'O' if v else 'X'}" for k, v in p1.items()))
    for k in ("주요", "비주요", "합산"):
        a, b = o[(k, 'dip')]['total_return'], o[(k, 'dca')]['total_return']
        out(f"2. 총수익률 {k}: 하락 {a:+.3f} vs 정액 {b:+.3f} -> {'O' if a >= b else 'X'}")
    x_on, x_off = o[("XLF", "dip")]['total_return'], off[("XLF", "dip")]['total_return']
    out(f"3. XLF 금리 조건 있음 {x_on:+.3f} vs 없음 {x_off:+.3f} -> {'O(동일: 조건이 작동한 적 없음, 효과 검증 불가)' if x_on == x_off else ('O' if x_on >= x_off else 'X')}")
    n = o[("합산", 'dip')]['buys']; out(f"4. 전체 매수 횟수 {n}회 (최소 20회) -> {'O' if n >= 20 else 'X'}")
    for k in ("주요", "비주요", "합산"):
        m = o[(k, 'dip')]; d = o[(k, 'dca')]
        out(f"   [{k}] MDD 하락 {m['mdd']:.3f} vs 정액 {d['mdd']:.3f}, 현금비율 {m['cash_ratio']:.2f}, IRR {m['irr']:.3f} vs {d['irr']:.3f}")
open("results/step3_summary.md", "w").write("\n".join(lines) + "\n")
