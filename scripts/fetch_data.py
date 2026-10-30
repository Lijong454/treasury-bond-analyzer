#!/usr/bin/env python3
"""
미국채 분석기 데이터 수집 스크립트 (GitHub Actions에서 매일 실행)

수집 대상
  1. data/yields.json      : 미 재무부 Daily Treasury Par Yield Curve (최근 3개 연도)
  2. data/fx.json          : USD/KRW 환율 (ECB 기준, Frankfurter API / 보조: open.er-api.com)
  3. data/securities.json  : 만기 미도래 Treasury Note/Bond 경매 정보 (CUSIP, 쿠폰, 만기 등)

각 소스는 독립적으로 처리합니다. 한 소스가 실패하면 기존 파일을 그대로 두고
나머지 소스만 갱신합니다. 모든 소스가 실패한 경우에만 종료 코드 1을 반환합니다.
표준 라이브러리만 사용합니다.
"""
from __future__ import annotations

import csv
import io
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 treasury-bond-analyzer"
)
NOW = datetime.now(timezone.utc)
TODAY = NOW.date()


def http_get(url: str, *, retries: int = 3, timeout: int = 40) -> bytes:
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"  ! {url} 시도 {i + 1}/{retries} 실패: {e}", file=sys.stderr)
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"GET 실패: {url}: {last}")


def write_json(name: str, obj) -> None:
    DATA.mkdir(exist_ok=True)
    path = DATA / name
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  -> {path.relative_to(ROOT)} ({path.stat().st_size:,} bytes)")


# ---------------------------------------------------------------------------
# 1. 수익률 곡선
# ---------------------------------------------------------------------------
def tenor_years(label: str) -> float | None:
    """'1 Mo' / '1.5 Month' / '1 Yr' 같은 헤더를 연 단위로 변환"""
    parts = label.strip().split()
    if len(parts) != 2:
        return None
    try:
        n = float(parts[0])
    except ValueError:
        return None
    unit = parts[1].lower()
    if unit.startswith("mo"):
        return round(n / 12, 6)
    if unit.startswith("w"):
        return round(n / 52, 6)
    if unit.startswith("yr") or unit.startswith("year"):
        return n
    return None


def short_label(label: str) -> str:
    n, unit = label.strip().split()
    n = n.rstrip("0").rstrip(".") if "." in n else n
    return f"{n}M" if unit.lower().startswith("mo") else f"{n}Y"


def fetch_yields() -> None:
    print("[1/3] 수익률 곡선")
    rows: dict[str, dict[str, float]] = {}
    labels: dict[str, float] = {}
    for year in (TODAY.year - 2, TODAY.year - 1, TODAY.year):
        url = (
            "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
            f"daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve"
            f"&field_tdr_date_value={year}&page&_format=csv"
        )
        try:
            text = http_get(url).decode("utf-8-sig")
        except RuntimeError as e:
            if year == TODAY.year:
                raise
            print(f"  ! {year}년 데이터 건너뜀: {e}", file=sys.stderr)
            continue
        reader = csv.DictReader(io.StringIO(text))
        n = 0
        for rec in reader:
            d = rec.get("Date")
            if not d:
                continue
            iso = datetime.strptime(d.strip(), "%m/%d/%Y").date().isoformat()
            vals = {}
            for k, v in rec.items():
                if k == "Date" or k is None:
                    continue
                ty = tenor_years(k)
                if ty is None or v in (None, "", "N/A"):
                    continue
                try:
                    vals[short_label(k)] = float(v)
                    labels[short_label(k)] = ty
                except ValueError:
                    pass
            if vals:
                rows[iso] = vals
                n += 1
        print(f"  {year}: {n}일")

    if not rows:
        raise RuntimeError("수익률 데이터가 비어 있음")
    tenors = sorted(labels, key=lambda k: labels[k])
    dates = sorted(rows)
    write_json(
        "yields.json",
        {
            "updated": NOW.isoformat(timespec="seconds"),
            "source": "U.S. Department of the Treasury — Daily Treasury Par Yield Curve Rates",
            "sourceUrl": "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve",
            "tenors": tenors,
            "tenorYears": [labels[t] for t in tenors],
            "rows": [[d] + [rows[d].get(t) for t in tenors] for d in dates],
        },
    )


# ---------------------------------------------------------------------------
# 2. 환율
# ---------------------------------------------------------------------------
def fetch_fx() -> None:
    print("[2/3] USD/KRW 환율")
    start = (TODAY - timedelta(days=365 * 3)).isoformat()
    series: dict[str, float] = {}
    source = None
    for url, name in (
        (f"https://api.frankfurter.dev/v1/{start}..?base=USD&symbols=KRW", "Frankfurter (ECB)"),
        (f"https://api.frankfurter.app/{start}..?from=USD&to=KRW", "Frankfurter (ECB)"),
    ):
        try:
            js = json.loads(http_get(url))
            for d, r in js.get("rates", {}).items():
                if "KRW" in r:
                    series[d] = float(r["KRW"])
            if series:
                source = name
                break
        except Exception as e:  # noqa: BLE001
            print(f"  ! {name} 실패: {e}", file=sys.stderr)

    latest = None
    try:
        js = json.loads(http_get("https://open.er-api.com/v6/latest/USD"))
        if js.get("result") == "success":
            latest = {
                "rate": float(js["rates"]["KRW"]),
                "asOf": datetime.fromtimestamp(js["time_last_update_unix"], timezone.utc).isoformat(timespec="seconds"),
                "source": "ExchangeRate-API (open.er-api.com)",
            }
    except Exception as e:  # noqa: BLE001
        print(f"  ! open.er-api 실패: {e}", file=sys.stderr)

    if not series and not latest:
        raise RuntimeError("환율 소스 모두 실패")
    dates = sorted(series)
    if latest is None:
        latest = {"rate": series[dates[-1]], "asOf": dates[-1], "source": source}
    print(f"  시계열 {len(dates)}일, 최신 {latest['rate']} ({latest['source']})")
    write_json(
        "fx.json",
        {
            "updated": NOW.isoformat(timespec="seconds"),
            "pair": "USD/KRW",
            "seriesSource": source,
            "latest": latest,
            "series": [[d, series[d]] for d in dates],
        },
    )


# ---------------------------------------------------------------------------
# 3. 국채 종목 (CUSIP)
# ---------------------------------------------------------------------------
def num(v):
    try:
        return None if v in (None, "", "null") else float(v)
    except ValueError:
        return None


def fetch_securities() -> None:
    print("[3/3] 국채 종목 (경매 데이터)")
    base = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query"
    fields = ",".join(
        [
            "cusip", "security_type", "security_term", "auction_date", "issue_date",
            "maturity_date", "int_rate", "high_yield", "price_per100", "reopening",
            "inflation_index_security", "floating_rate",
        ]
    )
    records = []
    page = 1
    while True:
        q = urllib.parse.urlencode(
            {
                "fields": fields,
                "filter": f"maturity_date:gte:{TODAY.isoformat()},security_type:in:(Note,Bond)",
                "sort": "-auction_date",
                "page[size]": 1000,
                "page[number]": page,
            },
            safe=":,()",
        )
        js = json.loads(http_get(f"{base}?{q}"))
        data = js.get("data", [])
        records.extend(data)
        total_pages = js.get("meta", {}).get("total-pages", 1)
        if page >= total_pages or not data:
            break
        page += 1

    by_cusip: dict[str, dict] = {}
    for r in records:
        if r.get("inflation_index_security") == "Yes" or r.get("floating_rate") == "Yes":
            continue  # TIPS / FRN 제외 (고정금리 명목채만)
        c = r["cusip"]
        auction = {
            "date": r["auction_date"],
            "yield": num(r.get("high_yield")),
            "price": num(r.get("price_per100")),
            "reopening": r.get("reopening") == "Yes",
        }
        s = by_cusip.get(c)
        if s is None:
            by_cusip[c] = s = {
                "cusip": c,
                "type": r["security_type"],
                "term": r["security_term"],
                "issueDate": r["issue_date"],
                "maturityDate": r["maturity_date"],
                "coupon": num(r.get("int_rate")),
                "auctions": [],
            }
        s["auctions"].append(auction)
        # 원 발행(재발행 아님) 정보를 우선 사용
        if r.get("reopening") != "Yes":
            s["issueDate"] = r["issue_date"]
            s["term"] = r["security_term"]
            if num(r.get("int_rate")) is not None:
                s["coupon"] = num(r.get("int_rate"))

    out = []
    for s in by_cusip.values():
        if s["coupon"] is None:
            continue
        s["auctions"].sort(key=lambda a: a["date"])
        out.append(s)
    out.sort(key=lambda s: s["maturityDate"])
    print(f"  {len(records)}건 경매 -> {len(out)}개 종목")
    if not out:
        raise RuntimeError("종목 데이터가 비어 있음")
    write_json(
        "securities.json",
        {
            "updated": NOW.isoformat(timespec="seconds"),
            "source": "U.S. Treasury Fiscal Data — Treasury Securities Auctions Data",
            "sourceUrl": "https://fiscaldata.treasury.gov/datasets/treasury-securities-auctions-data/",
            "securities": out,
        },
    )


def main() -> int:
    ok = 0
    for fn in (fetch_yields, fetch_fx, fetch_securities):
        try:
            fn()
            ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"  X {fn.__name__} 실패, 기존 파일 유지: {e}", file=sys.stderr)
    meta = {"lastRun": NOW.isoformat(timespec="seconds"), "succeeded": ok, "total": 3}
    write_json("meta.json", meta)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
