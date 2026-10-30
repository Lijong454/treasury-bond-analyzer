/**
 * 채권 계산 엔진 (순수 함수, 브라우저·Node 공용 ES 모듈)
 *
 * 규칙
 *  - 미 국채(Note/Bond) 반기 이표, 경과이자는 Actual/Actual (ICMA)
 *  - 가격/수익률은 street convention: 반기 복리, 첫 기간은 일수 비례 분수 기간
 *  - 가격은 액면 100 기준
 *  - 날짜는 'YYYY-MM-DD' 문자열 또는 UTC Date
 */

const DAY = 86400000;

export function toDate(d) {
  if (d instanceof Date) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd));
}
export const iso = (d) => toDate(d).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);
export const yearsBetween = (a, b) => daysBetween(a, b) / 365.25;

const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const isEOM = (d) => d.getUTCDate() === lastDayOfMonth(d.getUTCFullYear(), d.getUTCMonth());

export function addMonths(date, n, eom = false) {
  const d = toDate(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const last = lastDayOfMonth(ty, tm);
  const day = eom ? last : Math.min(d.getUTCDate(), last);
  return new Date(Date.UTC(ty, tm, day));
}

/** 결제일 이후의 이표일 목록과 직전 이표일 */
export function couponSchedule(settle, maturity) {
  const s = toDate(settle);
  const mat = toDate(maturity);
  if (mat <= s) throw new Error('만기일은 매수일 이후여야 합니다.');
  const eom = isEOM(mat);
  const future = [];
  let k = 0;
  let d = mat;
  while (d > s) {
    future.unshift(d);
    k += 1;
    d = addMonths(mat, -6 * k, eom);
  }
  return { prev: d, next: future[0], dates: future };
}

/** 액면 100당 경과이자 */
export function accruedInterest(settle, maturity, couponPct) {
  const { prev, next } = couponSchedule(settle, maturity);
  const frac = daysBetween(prev, settle) / daysBetween(prev, next);
  return (couponPct / 2) * frac;
}

function pvTerms(settle, maturity, couponPct, yieldPct) {
  const { prev, next, dates } = couponSchedule(settle, maturity);
  const w = daysBetween(settle, next) / daysBetween(prev, next); // 첫 이표까지 남은 기간(분수)
  const v = 1 + yieldPct / 200;
  const c = couponPct / 2;
  return dates.map((date, i) => {
    const cf = c + (i === dates.length - 1 ? 100 : 0);
    const t = w + i; // 반기 단위
    return { date, cf, t, pv: cf / Math.pow(v, t) };
  });
}

/** 수익률(%) -> 액면 100당 dirty price */
export function dirtyPriceFromYield(settle, maturity, couponPct, yieldPct) {
  return pvTerms(settle, maturity, couponPct, yieldPct).reduce((s, x) => s + x.pv, 0);
}

export function cleanPriceFromYield(settle, maturity, couponPct, yieldPct) {
  return dirtyPriceFromYield(settle, maturity, couponPct, yieldPct) - accruedInterest(settle, maturity, couponPct);
}

/** clean price -> 만기수익률(%) (이분법, 안정적) */
export function yieldFromCleanPrice(settle, maturity, couponPct, cleanPrice) {
  const target = cleanPrice + accruedInterest(settle, maturity, couponPct);
  let lo = -5;
  let hi = 60;
  const f = (y) => dirtyPriceFromYield(settle, maturity, couponPct, y) - target;
  if (f(lo) < 0 || f(hi) > 0) throw new Error('가격에 해당하는 수익률을 찾을 수 없습니다.');
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

/** 듀레이션·컨벡시티 (연 단위) */
export function riskMeasures(settle, maturity, couponPct, yieldPct) {
  const terms = pvTerms(settle, maturity, couponPct, yieldPct);
  const P = terms.reduce((s, x) => s + x.pv, 0);
  const v = 1 + yieldPct / 200;
  const macHalf = terms.reduce((s, x) => s + x.t * x.pv, 0) / P;
  const convHalf = terms.reduce((s, x) => s + x.t * (x.t + 1) * x.pv, 0) / (P * v * v);
  const macaulay = macHalf / 2;
  const modified = macaulay / v;
  const convexity = convHalf / 4;
  return { dirty: P, macaulay, modified, convexity, dv01: (modified * P) / 10000 };
}

/** 결제일 이후 현금흐름 (액면 face USD 기준) */
export function cashflows(settle, maturity, couponPct, face) {
  const { dates } = couponSchedule(settle, maturity);
  return dates.map((d, i) => {
    const coupon = (face * couponPct) / 200;
    const principal = i === dates.length - 1 ? face : 0;
    return { date: iso(d), coupon, principal, total: coupon + principal };
  });
}

/** 연 단위 IRR (Actual/365), flows: [{date, amount}] */
export function irr(flows) {
  const t0 = toDate(flows[0].date);
  const ts = flows.map((f) => (toDate(f.date) - t0) / DAY / 365);
  const npv = (r) => flows.reduce((s, f, i) => s + f.amount / Math.pow(1 + r, ts[i]), 0);
  let lo = -0.99;
  let hi = 5;
  if (npv(lo) * npv(hi) > 0) return NaN;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-12) break;
  }
  return (lo + hi) / 2;
}

/** 수익률 곡선 선형 보간 (tenorYears 오름차순) */
export function interpolateCurve(tenorYears, yields, years) {
  const pts = tenorYears.map((t, i) => [t, yields[i]]).filter(([, y]) => y != null && !Number.isNaN(y));
  if (!pts.length) return null;
  if (years <= pts[0][0]) return pts[0][1];
  if (years >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    const [t1, y1] = pts[i];
    const [t0, y0] = pts[i - 1];
    if (years <= t1) return y0 + ((y1 - y0) * (years - t0)) / (t1 - t0);
  }
  return null;
}

/**
 * 원화 기준 투자 분석
 *
 * p = {
 *   settle, maturity, coupon(%), cleanPrice(액면100당), face(USD 액면 총액),
 *   fxBuy(매수 시 기준환율), fxExit(회수 시점 기준환율),
 *   fxSpread(원, 환전 시 불리하게 적용), commissionPct(매수·중도매도 수수료 %),
 *   taxRate(이자소득세율, 예 0.154),
 *   exitDate?(중도 매도일, 없으면 만기 보유), exitYield?(중도 매도 시 수익률 %)
 * }
 *
 * 세금 가정: 보유기간 이자 과세 = 수령 이표 − 매수 시 지급 경과이자 + 매도 시 수령 경과이자.
 *           채권 매매차익·환차익은 개인 비과세.
 * 환율 경로: 매수일 → 회수일 사이 선형 보간, 이표는 지급일에 즉시 원화 환전 가정.
 */
export function analyzeInvestment(p) {
  const settle = iso(p.settle);
  const maturity = iso(p.maturity);
  const spread = p.fxSpread || 0;
  const comm = (p.commissionPct || 0) / 100;
  const taxRate = p.taxRate ?? 0.154;
  const holdToMaturity = !p.exitDate || toDate(p.exitDate) >= toDate(maturity);
  const exitDate = holdToMaturity ? maturity : iso(p.exitDate);
  if (toDate(exitDate) <= toDate(settle)) throw new Error('회수일은 매수일 이후여야 합니다.');

  const units = p.face / 100;
  const aiBuy = accruedInterest(settle, maturity, p.coupon);
  const buyUSD = units * (p.cleanPrice + aiBuy) * (1 + comm);
  const buyFx = p.fxBuy + spread;
  const investKRW = buyUSD * buyFx;

  const totalDays = daysBetween(settle, exitDate);
  const fxAt = (d) => p.fxBuy + ((p.fxExit - p.fxBuy) * daysBetween(settle, d)) / totalDays;

  const flows = [];
  let aiOffset = units * aiBuy; // 첫 이표에서 차감할 매수 경과이자
  for (const cf of cashflows(settle, maturity, p.coupon, p.face)) {
    if (toDate(cf.date) > toDate(exitDate)) break;
    const fx = fxAt(cf.date) - spread;
    let taxableUSD = cf.coupon;
    if (aiOffset > 0) {
      const used = Math.min(aiOffset, taxableUSD);
      taxableUSD -= used;
      aiOffset -= used;
    }
    const taxKRW = taxableUSD * fx * taxRate;
    if (cf.coupon > 0) {
      flows.push({ date: cf.date, kind: 'coupon', usd: cf.coupon, fx, krw: cf.coupon * fx, tax: taxKRW });
    }
    if (cf.principal > 0) {
      flows.push({ date: cf.date, kind: 'principal', usd: cf.principal, fx, krw: cf.principal * fx, tax: 0 });
    }
  }

  let exitInfo = null;
  if (!holdToMaturity) {
    const exitYield = p.exitYield;
    const clean = cleanPriceFromYield(exitDate, maturity, p.coupon, exitYield);
    const ai = accruedInterest(exitDate, maturity, p.coupon);
    const grossUSD = units * (clean + ai);
    const netUSD = grossUSD * (1 - comm);
    const fx = p.fxExit - spread;
    const taxableAI = Math.max(0, units * ai - aiOffset);
    flows.push({ date: exitDate, kind: 'sale', usd: netUSD, fx, krw: netUSD * fx, tax: taxableAI * fx * taxRate });
    exitInfo = { clean, accrued: ai, exitYield };
  }

  const sum = (k) => flows.reduce((s, f) => s + f[k], 0);
  const receivedUSD = sum('usd');
  const grossKRW = sum('krw');
  const taxKRW = sum('tax');
  const netKRW = grossKRW - taxKRW;

  const couponUSD = flows.filter((f) => f.kind === 'coupon').reduce((s, f) => s + f.usd, 0);
  const pnlUSD = receivedUSD - buyUSD;
  const profitPre = grossKRW - investKRW;
  const profitPost = netKRW - investKRW;
  // 손익 분해: 달러 기준 손익을 매수 환율로 환산한 부분 vs 환율 변화분
  const usdPartKRW = pnlUSD * buyFx;
  const fxPartKRW = profitPre - usdPartKRW;
  const capitalUSD = pnlUSD - couponUSD;

  const years = yearsBetween(settle, exitDate);
  const irrPre = irr([{ date: settle, amount: -investKRW }, ...flows.map((f) => ({ date: f.date, amount: f.krw }))]);
  const irrPost = irr([{ date: settle, amount: -investKRW }, ...flows.map((f) => ({ date: f.date, amount: f.krw - f.tax }))]);
  const irrUSD = irr([{ date: settle, amount: -buyUSD }, ...flows.map((f) => ({ date: f.date, amount: f.usd }))]);

  return {
    settle, maturity, exitDate, holdToMaturity, years,
    accruedPer100: aiBuy, buyUSD, buyFx, investKRW,
    flows, receivedUSD, grossKRW, taxKRW, netKRW,
    couponUSD, capitalUSD, pnlUSD,
    profitPre, profitPost,
    returnPre: profitPre / investKRW, returnPost: profitPost / investKRW,
    irrPre, irrPost, irrUSD,
    breakdown: {
      couponKRW: couponUSD * buyFx,
      capitalKRW: capitalUSD * buyFx,
      fxKRW: fxPartKRW,
      taxKRW: -taxKRW,
    },
    exitInfo,
  };
}

/** 세후 원화 손익이 0이 되는 회수 시점 환율 */
export function breakevenFx(p) {
  const f = (fx) => analyzeInvestment({ ...p, fxExit: fx }).profitPost;
  let lo = p.fxBuy * 0.2;
  let hi = p.fxBuy * 3;
  if (f(lo) > 0) return lo;
  if (f(hi) < 0) return NaN;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** 연도별 이자 수입 (원화, 세전) — 금융소득종합과세 점검용 */
export function couponsByYear(flows) {
  const m = new Map();
  for (const f of flows) {
    if (f.kind !== 'coupon') continue;
    const y = f.date.slice(0, 4);
    const cur = m.get(y) || { usd: 0, krw: 0, tax: 0 };
    cur.usd += f.usd;
    cur.krw += f.krw;
    cur.tax += f.tax;
    m.set(y, cur);
  }
  return [...m.entries()].map(([year, v]) => ({ year, ...v }));
}
