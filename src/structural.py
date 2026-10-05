"""구조적 개선 비교: 같은 시장 수익률에서 보수·세금·계좌만 바꿨을 때 20년 뒤 세후 금액.
시장 예측이 없으므로 백테스트 구간을 쓰지 않는다. 모든 시나리오는 20년 뒤 전부 찾는다고 가정 (세후 비교).
세법은 2026년 확인 기준 (ISA 한도 확대는 미확정 -> 현행·확대안 둘 다). 가정은 아래 상수만 바꾸면 된다.
"""
import sys

MONTHLY = 1_000_000        # 월 납입 (원)
YEARS = 20
PRICE = 0.07               # 연 가격 상승률 (가정)
DIV = 0.010                # 연 배당률 (SPY·QQQ 반반 근사)
DIV_WHT = 0.15             # 배당 원천징수 (미국 15%, 국내 상장 해외 ETF도 보수적으로 15%)
FX = 0.001                 # 미국 상장 ETF 매수 시 환전 비용 (우대 가정)
CG_RATE, CG_DED = 0.22, 2_500_000           # 해외주식 양도세, 연 기본공제
PEN_LIMIT, PEN_CREDIT = 6_000_000, 0.132    # 연금저축 공제 한도, 공제율 (총급여 5,500만원 초과 기준, 이하는 16.5%)

def grow(bal, er):
    """한 달: 가격 상승 + 세후 배당 재투자 - 보수."""
    return bal * (1 + PRICE / 12 + DIV / 12 * (1 - DIV_WHT) - er / 12)

def taxable(er, fx=FX, harvest=False, monthly=MONTHLY, extra=None):
    """일반 계좌 (미국 상장 ETF). harvest: 매년 말 이익 250만원까지 팔고 다시 사서 취득가를 올림 (비과세)."""
    bal = basis = 0.0
    for m in range(YEARS * 12):
        add = monthly + (extra[m] if extra else 0.0)
        bal += add * (1 - fx); basis += add
        bal = grow(bal, er)
        if harvest and m % 12 == 11 and m < YEARS * 12 - 1:
            g = bal - basis
            if g > 0:
                step = min(g, CG_DED); sold = bal * step / g
                bal -= sold * 0.0025                     # 매도·재매수 수수료 (왕복 0.25% 가정)
                basis += step
    return bal - CG_RATE * max(0.0, bal - basis - CG_DED)

def pension_plus_taxable(er_pen, pen_tax, credit=PEN_CREDIT):
    """연 600만원은 연금저축(국내 상장 미국 지수 ETF), 나머지는 일반 계좌(저보수 + 공제 활용).
    세액공제 환급금은 다음 해 2월 일반 계좌에 추가 투자. 연금은 수령 시 pen_tax로 과세."""
    pm = PEN_LIMIT / 12; bal = 0.0; extra = [0.0] * (YEARS * 12)
    for m in range(YEARS * 12):
        bal = grow(bal + pm, er_pen)
        if m % 12 == 11 and m + 2 < YEARS * 12: extra[m + 2] += PEN_LIMIT * credit
    return bal * (1 - pen_tax) + taxable(0.0009, harvest=True, monthly=MONTHLY - pm, extra=extra)

def isa(er, free, cycle=3):
    """ISA에 전액 (국내 상장 미국 지수 ETF). cycle년마다 만기 정산: 이익 중 free 초과분 9.9%, 새 ISA로 재투자."""
    bal = basis = 0.0
    for m in range(YEARS * 12):
        bal += MONTHLY; basis += MONTHLY; bal = grow(bal, er)
        if (m + 1) % (cycle * 12) == 0 or m == YEARS * 12 - 1:
            bal -= 0.099 * max(0.0, bal - basis - free); basis = bal
    return bal

if __name__ == "__main__":
    for p in [float(x) for x in sys.argv[1:]] or [PRICE]:
        PRICE = p
        paid = MONTHLY * 12 * YEARS
        rows = [
            ("A 현재: SPY·QQQ 일반계좌", taxable(0.00147)),
            ("B 저보수 VOO·QQQM", taxable(0.0009)),
            ("C B + 매년 250만원 공제 활용", taxable(0.0009, harvest=True)),
            ("D C + 연금저축 600만원 (수령세 5.5%)", pension_plus_taxable(0.002, 0.055)),
            ("D' 같은데 수령세 16.5% (연 1,500만원 초과)", pension_plus_taxable(0.002, 0.165)),
            ("E ISA 전액, 현행 비과세 200만원", isa(0.002, 2_000_000)),
            ("E' ISA 전액, 확대안 500만원 (미확정)", isa(0.002, 5_000_000)),
        ]
        a = rows[0][1]
        print(f"\n가격 상승 {PRICE:.0%}/년, 배당 {DIV:.1%}, 월 {MONTHLY:,}원 x {YEARS}년 (원금 {paid / 1e8:.1f}억)  — 20년 뒤 전부 찾을 때 세후")
        for name, v in rows:
            print(f"  {name:36} {v / 1e8:6.2f}억  A 대비 {v - a:+13,.0f}원 ({v / a - 1:+.1%})")
