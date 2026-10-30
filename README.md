# 미국채 투자 분석기

원화로 미국 국채(Treasury Note/Bond)에 직접 투자할 때의 **세후 원화 수익률**, **환율·금리 시나리오**, **수익률 곡선**을 분석하는 웹 앱입니다.

**사용하기:** https://lijong454.github.io/treasury-bond-analyzer/

## 기능

| 탭 | 내용 |
|---|---|
| 채권 분석 | CUSIP·만기·쿠폰으로 실제 국채 종목 검색 → 가격↔수익률(YTM) 변환, 경과이자, 듀레이션·컨벡시티·DV01, 원화 투자원금, **세후 원화 연수익률(IRR)**, 손익 분해(이자/가격/환율/세금), **손익분기 환율**, 만기 환율 시나리오, 연도별 이자와 금융소득종합과세(2,000만 원) 점검, 현금흐름 표 |
| 금리·환율 시나리오 | 중도 매도일·매도 환율·수익률 변화(±300bp)에 따른 매도 가격과 세후 수익, 가격-수익률 곡선(볼록성), **금리 × 환율 매트릭스** |
| 수익률 곡선 | 오늘 곡선과 1주·1개월·3개월·1년 전·임의 날짜 비교, 2년·10년·30년 금리 추이, 10Y−2Y 금리차, USD/KRW 추이 |
| 포트폴리오 | 분석한 채권을 담아 현재 곡선·환율 기준 추정 평가액, 가중 YTM·듀레이션, 연도별 현금흐름과 이자소득 (브라우저에 저장, JSON 내보내기/가져오기) |

## 데이터

GitHub Actions(`.github/workflows/update-and-deploy.yml`)가 평일마다 아래 데이터를 받아 `data/`에 저장하고 사이트를 다시 배포합니다.

- 수익률 곡선: [U.S. Treasury — Daily Treasury Par Yield Curve Rates](https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve)
- 국채 종목(CUSIP·쿠폰·만기·경매 결과): [Treasury Fiscal Data — Treasury Securities Auctions Data](https://fiscaldata.treasury.gov/datasets/treasury-securities-auctions-data/) (만기 미도래 고정금리 Note/Bond, TIPS·FRN 제외)
- 환율: [Frankfurter](https://frankfurter.dev/)(ECB 기준환율) 시계열 + [ExchangeRate-API](https://www.exchangerate-api.com/docs/free) 최신값. 브라우저에서도 최신 환율을 한 번 더 확인합니다.

수동 갱신: GitHub 저장소 → Actions → "데이터 갱신 및 배포" → Run workflow

## 계산 가정

- 미 국채 관행: 반기 이표, 반기 복리, 경과이자 Actual/Actual. 가격은 액면 100당 clean price.
- 원화 수익률: 매수일→회수일 환율이 직선으로 움직이고, 이표는 받는 즉시 원화로 바꾼다고 가정한 IRR.
- 세금(한국 거주 개인, 일반 계좌): 이자 15.4% 원천징수(보유기간 이자 기준), 채권 매매차익·환차익 비과세. 금융소득종합과세는 초과 여부만 표시.
- 정보 제공용 계산기이며 투자 권유가 아닙니다. 실제 가격·수수료·세금은 증권사에 확인하세요.

## 개발

빌드 과정이 없는 정적 사이트입니다(HTML + ES 모듈, Chart.js는 `vendor/`에 포함).

```bash
python3 scripts/fetch_data.py   # data/*.json 생성 (인터넷 필요)
python3 -m http.server 8000     # http://localhost:8000
npm test                        # 채권 계산 엔진 테스트 (Node 18+)
```

```
index.html            화면
css/style.css         스타일
js/bond-math.js       채권 계산 엔진 (가격·수익률·듀레이션·원화 IRR·세금)
js/data.js            데이터 로딩
js/app.js             화면 로직·차트
scripts/fetch_data.py 데이터 수집 (GitHub Actions)
tests/                계산 엔진 테스트
```
