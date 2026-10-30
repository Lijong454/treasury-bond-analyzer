/**
 * 데이터 로딩: GitHub Actions가 저장한 data/*.json + 브라우저에서 최신 환율 보강
 */

async function getJSON(url, { timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { cache: 'no-cache', signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const safe = (p) => p.catch((e) => { console.warn('[data]', e.message || e); return null; });

/** 브라우저에서 최신 환율 시도 (CORS 허용 공개 API). 실패해도 무시 */
async function liveFx() {
  const tries = [
    async () => {
      const j = await getJSON('https://open.er-api.com/v6/latest/USD', { timeout: 6000 });
      return { rate: j.rates.KRW, asOf: new Date(j.time_last_update_unix * 1000).toISOString(), source: 'ExchangeRate-API' };
    },
    async () => {
      const j = await getJSON('https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW', { timeout: 6000 });
      return { rate: j.rates.KRW, asOf: j.date, source: 'Frankfurter (ECB)' };
    },
  ];
  for (const t of tries) {
    try {
      const r = await t();
      if (r.rate > 0) return r;
    } catch { /* 다음 소스 */ }
  }
  return null;
}

export async function loadData() {
  const [yields, fx, secs, live] = await Promise.all([
    safe(getJSON('data/yields.json')),
    safe(getJSON('data/fx.json')),
    safe(getJSON('data/securities.json')),
    liveFx(),
  ]);
  return new MarketData(yields, fx, secs, live);
}

export class MarketData {
  constructor(yields, fx, secs, live) {
    this.yields = yields;
    this.fxData = fx;
    this.securities = secs?.securities || [];
    this.secsMeta = secs;
    this.live = live;

    if (yields?.rows?.length) {
      this.tenors = yields.tenors;
      this.tenorYears = yields.tenorYears;
      this.rows = yields.rows; // [date, ...values] 오름차순
    } else {
      this.tenors = [];
      this.tenorYears = [];
      this.rows = [];
    }
  }

  get hasCurve() { return this.rows.length > 0; }

  /** 최신 환율: 저장 데이터와 실시간 중 더 최신 */
  get fx() {
    const stored = this.fxData?.latest || null;
    if (this.live && (!stored || new Date(this.live.asOf) >= new Date(stored.asOf))) return this.live;
    return stored;
  }

  get fxSeries() { return this.fxData?.series || []; }

  latestRow() { return this.rows[this.rows.length - 1] || null; }

  /** 기준일 이전(포함) 가장 가까운 영업일 행 */
  rowOnOrBefore(isoDate) {
    let lo = 0;
    let hi = this.rows.length - 1;
    let ans = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.rows[mid][0] <= isoDate) { ans = this.rows[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  rowDaysAgo(days) {
    const last = this.latestRow();
    if (!last) return null;
    const d = new Date(last[0] + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - days);
    return this.rowOnOrBefore(d.toISOString().slice(0, 10));
  }

  value(row, tenor) {
    const i = this.tenors.indexOf(tenor);
    return i < 0 || !row ? null : row[i + 1];
  }

  curveOf(row) { return row ? row.slice(1) : []; }

  search(q, limit = 30) {
    const s = q.trim().toUpperCase();
    if (!s) return [];
    const parts = s.split(/[\s,]+/).filter(Boolean);
    const out = [];
    for (const sec of this.securities) {
      const hay = `${sec.cusip} ${sec.maturityDate} ${sec.coupon.toFixed(3)} ${sec.coupon} ${sec.type} ${sec.term}`.toUpperCase();
      if (parts.every((p) => hay.includes(p))) {
        out.push(sec);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  byCusip(c) { return this.securities.find((s) => s.cusip === c) || null; }
}
