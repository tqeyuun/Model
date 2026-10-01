# 데이터 구간 (시간순 분리)
- train/        2010-01-01 ~ 2018-12-31  학습
- val/          2019-01-01 ~ 2022-12-31  검증 (설정 조정은 여기서만, 최대 5회)
- _sealed_test/ 2023-01-01 ~ 현재        최종 테스트 — 사용자가 "최종 테스트 실행해줘"라고 할 때까지 분석 코드에서 읽지 않는다
- raw/          전체 원본 (분석 코드에서 읽지 않는다. 구간 분리는 src/fetch_data.py 가 수행)

출처: Yahoo Finance 일봉(open/high/low/close/adjclose/volume), FRED DGS10·DGS2 (spread_10y2y = DGS10 - DGS2).
금리는 미국 공휴일 등 결측(NaN) 포함 — 사용 시 직전 영업일 값만 이월(forward-fill)할 것.
