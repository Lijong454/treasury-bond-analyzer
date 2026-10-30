import {
  analyzeInvestment, breakevenFx, cleanPriceFromYield, yieldFromCleanPrice, riskMeasures,
  accruedInterest, interpolateCurve, couponsByYear, cashflows, yearsBetween, addMonths, iso, toDate,
} from './bond-math.js';
import { loadData } from './data.js';

/* ------------------------------------------------------------------ */
/* 유틸                                                                */
/* ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const nf0 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const won = (x) => (Number.isFinite(x) ? `${x < 0 ? '−' : ''}₩${nf0.format(Math.abs(x))}` : '-');
const wonS = (x) => (Number.isFinite(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}₩${nf0.format(Math.abs(x))}` : '-');
const usd = (x) => (Number.isFinite(x) ? `${x < 0 ? '−' : ''}$${nf2.format(Math.abs(x))}` : '-');
const pct = (x, d = 2) => (Number.isFinite(x) ? `${(Math.abs(x) < 0.5 * 10 ** -(d + 2) ? 0 : x * 100).toFixed(d)}%` : '-');
const pctS = (x, d = 2) => {
  if (!Number.isFinite(x)) return '-';
  const t = Math.abs(x * 100).toFixed(d);
  return `${Number(t) === 0 ? '' : x > 0 ? '+' : '−'}${t}%`;
};
const yld = (y, d = 3) => (Number.isFinite(y) ? `${y.toFixed(d)}%` : '-');
const fxf = (x) => (Number.isFinite(x) ? nf2.format(x) : '-');
const bp = (x) => (Number.isFinite(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(Math.round(x))}bp` : '-');
const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const store = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
};

/* ------------------------------------------------------------------ */
/* 차트 공통                                                           */
/* ------------------------------------------------------------------ */
const C = {
  s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', s4: '#eda100', s5: '#6250d6', s6: '#e87ba4',
  ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', bad: '#d03b3b',
};
const charts = {};
function chart(id, config) {
  if (!window.Chart) return;
  charts[id]?.destroy();
  charts[id] = new window.Chart($(id), config);
}
if (window.Chart) {
  const D = window.Chart.defaults;
  D.font.family = getComputedStyle(document.documentElement).fontFamily;
  D.font.size = 12;
  D.color = C.ink2;
  D.borderColor = C.grid;
  D.maintainAspectRatio = false;
  D.animation = false;
  D.plugins.legend.labels.boxWidth = 12;
  D.plugins.legend.labels.boxHeight = 2;
  D.plugins.legend.position = 'top';
  D.plugins.legend.align = 'end';
  D.plugins.tooltip.backgroundColor = C.ink;
  D.plugins.tooltip.padding = 8;
  D.plugins.tooltip.cornerRadius = 6;
  D.elements.line.borderWidth = 2;
  D.elements.point.radius = 0;
  D.elements.point.hoverRadius = 4;
  D.elements.bar.borderRadius = 4;
}
const axis = (extra = {}) => ({
  grid: { color: C.grid, drawTicks: false },
  border: { color: C.axis },
  ticks: { color: C.muted, padding: 6 },
  ...extra,
});
const lineDs = (label, data, color, extra = {}) => ({
  label, data, borderColor: color, backgroundColor: color, pointHoverBackgroundColor: color, tension: 0, ...extra,
});

/* ------------------------------------------------------------------ */
/* 상태                                                                */
/* ------------------------------------------------------------------ */
let M = null;           // MarketData
let current = null;     // 마지막 계산 결과
let picked = null;      // 선택한 종목
const FIELDS = ['settle', 'maturity', 'coupon', 'face', 'priceInput', 'fxBuy', 'fxExit', 'fxSpread', 'commission', 'taxRate', 'otherIncome'];

function defaults() {
  const fx = M?.fx?.rate ? Math.round(M.fx.rate * 10) / 10 : 1400;
  const y10 = M?.hasCurve ? M.value(M.latestRow(), '10Y') : null;
  const today = todayLocal();
  // 기본 예시: 가장 최근 발행된 10년물(있으면), 없으면 가상의 10년 만기 채권
  let sec = null;
  if (M?.securities?.length) {
    sec = M.securities
      .filter((s) => s.term?.startsWith('10-Year') && s.maturityDate > today)
      .sort((a, b) => (a.issueDate < b.issueDate ? 1 : -1))[0] || null;
  }
  return {
    settle: today,
    maturity: sec ? sec.maturityDate : iso(addMonths(today, 120)),
    coupon: sec ? sec.coupon : (y10 ? Math.round(y10 * 8) / 8 : 4.25),
    face: 10000,
    priceMode: 'yield',
    priceInput: y10 ?? 4.25,
    fxBuy: fx,
    fxExit: fx,
    fxSpread: 2,
    commission: 0,
    taxRate: 15.4,
    otherIncome: 0,
    cusip: sec?.cusip || null,
  };
}

function writeForm(v) {
  for (const f of FIELDS) if (v[f] !== undefined && v[f] !== null) $(f).value = v[f];
  document.querySelector(`input[name=priceMode][value=${v.priceMode || 'price'}]`).checked = true;
  setPicked(v.cusip ? M.byCusip(v.cusip) : null, false);
}

function readForm() {
  const g = (id) => $(id).value;
  const n = (id) => Number($(id).value);
  return {
    settle: g('settle'),
    maturity: g('maturity'),
    coupon: n('coupon'),
    face: n('face'),
    priceMode: document.querySelector('input[name=priceMode]:checked').value,
    priceInput: n('priceInput'),
    fxBuy: n('fxBuy'),
    fxExit: n('fxExit'),
    fxSpread: n('fxSpread') || 0,
    commission: n('commission') || 0,
    taxRate: Number.isFinite(n('taxRate')) ? n('taxRate') : 15.4,
    otherIncome: n('otherIncome') || 0,
    cusip: picked?.cusip || null,
  };
}

/* ------------------------------------------------------------------ */
/* 시장 요약                                                           */
/* ------------------------------------------------------------------ */
function renderMarket() {
  const fx = M.fx;
  if (fx) {
    $('mkFx').textContent = fxf(fx.rate);
    $('mkFxDate').textContent = String(fx.asOf).slice(0, 10);
  }
  if (!M.hasCurve) return;
  const last = M.latestRow();
  const prev = M.rows[M.rows.length - 2];
  for (const [t, id] of [['2Y', 'mk2y'], ['10Y', 'mk10y'], ['30Y', 'mk30y']]) {
    const v = M.value(last, t);
    const p = M.value(prev, t);
    $(id).textContent = yld(v, 2);
    const ch = $(`${id}Chg`);
    if (Number.isFinite(p)) {
      const d = (v - p) * 100;
      ch.textContent = `전일 ${bp(d)}`;
      ch.className = d > 0 ? 'up' : d < 0 ? 'down' : '';
    }
  }
  const sp = (M.value(last, '10Y') - M.value(last, '2Y')) * 100;
  $('mkSpread').textContent = bp(sp);
  $('mkCurveDate').textContent = last[0];
}

function renderNotice() {
  const miss = [];
  if (!M.hasCurve) miss.push('수익률 곡선');
  if (!M.securities.length) miss.push('국채 종목 목록');
  if (!M.fx) miss.push('환율');
  const n = $('dataNotice');
  if (miss.length) {
    n.textContent = `${miss.join(', ')} 데이터를 불러오지 못했어요. 자동 수집(GitHub Actions)이 처음 실행되기 전이거나 일시적인 오류일 수 있어요. 값을 직접 입력하면 계산은 그대로 할 수 있어요.`;
    n.classList.remove('hidden');
  } else n.classList.add('hidden');

  const stamp = [];
  if (M.yields) stamp.push(`수익률 곡선 ${M.latestRow()?.[0]} (수집 ${M.yields.updated.slice(0, 16).replace('T', ' ')} UTC)`);
  if (M.fx) stamp.push(`환율 ${String(M.fx.asOf).slice(0, 10)} · ${M.fx.source}`);
  if (M.secsMeta) stamp.push(`국채 종목 ${M.securities.length}개 (수집 ${M.secsMeta.updated.slice(0, 10)})`);
  $('dataStamp').textContent = stamp.length ? `데이터 기준: ${stamp.join(' / ')}` : '';
}

/* ------------------------------------------------------------------ */
/* 종목 검색                                                           */
/* ------------------------------------------------------------------ */
let sugIdx = -1;
function secLabel(s) {
  return `${s.term} ${s.type} ${s.coupon.toFixed(3)}% · ${s.maturityDate} 만기`;
}
function renderSuggest() {
  const q = $('search').value;
  const ul = $('suggest');
  if (!q.trim()) { ul.classList.add('hidden'); return; }
  const list = M.search(q);
  sugIdx = -1;
  ul.innerHTML = list.length
    ? list.map((s, i) => `<li role="option" data-i="${i}" data-cusip="${s.cusip}"><span>${esc(secLabel(s))}</span><b>${s.cusip}</b><small>발행 ${s.issueDate} · 최근 경매 ${s.auctions.at(-1)?.date ?? '-'}</small></li>`).join('')
    : `<li class="empty">${M.securities.length ? '일치하는 종목이 없어요' : '종목 데이터가 아직 없어요'}</li>`;
  ul.classList.remove('hidden');
}
function moveSuggest(d) {
  const items = [...$('suggest').querySelectorAll('li[data-cusip]')];
  if (!items.length) return;
  sugIdx = (sugIdx + d + items.length) % items.length;
  items.forEach((li, i) => li.setAttribute('aria-selected', i === sugIdx));
  items[sugIdx].scrollIntoView({ block: 'nearest' });
}
function choose(cusip) {
  const s = M.byCusip(cusip);
  if (!s) return;
  $('suggest').classList.add('hidden');
  $('search').value = '';
  $('maturity').value = s.maturityDate;
  $('coupon').value = s.coupon;
  setPicked(s, true);
  recalc();
}
function setPicked(s, fillPrice) {
  picked = s;
  const box = $('picked');
  if (!s) { box.classList.add('hidden'); return; }
  const a = s.auctions.at(-1);
  box.innerHTML = `<div><b>${s.cusip}</b> · ${esc(secLabel(s))}<br><span class="muted">발행 ${s.issueDate}${a ? ` · 최근 경매 ${a.date} 낙찰수익률 ${yld(a.yield)}${a.price ? `, 가격 ${a.price.toFixed(4)}` : ''}` : ''}</span></div><button type="button" id="unpick" aria-label="선택 해제">해제</button>`;
  box.classList.remove('hidden');
  $('unpick').onclick = () => { setPicked(null); recalc(); };
  if (fillPrice) {
    const est = curveYield($('settle').value, s.maturityDate);
    document.querySelector('input[name=priceMode][value=yield]').checked = true;
    $('priceInput').value = (est ?? a?.yield ?? 4).toFixed(3);
  }
}

function curveYield(settle, maturity) {
  if (!M.hasCurve) return null;
  const yrs = yearsBetween(settle, maturity);
  return interpolateCurve(M.tenorYears, M.curveOf(M.latestRow()), yrs);
}

/* ------------------------------------------------------------------ */
/* 계산                                                                */
/* ------------------------------------------------------------------ */
function compute(v) {
  const err = [];
  if (!v.settle || !v.maturity) err.push('날짜를 입력하세요.');
  else if (v.maturity <= v.settle) err.push('만기일은 매수일 이후여야 해요.');
  if (!(v.coupon >= 0)) err.push('쿠폰을 확인하세요.');
  if (!(v.face > 0)) err.push('액면 총액을 확인하세요.');
  if (!(v.fxBuy > 0) || !(v.fxExit > 0)) err.push('환율을 확인하세요.');
  if (!Number.isFinite(v.priceInput) || (v.priceMode === 'price' && v.priceInput <= 0)) err.push('매수 가격/수익률을 확인하세요.');
  if (err.length) throw new Error(err.join(' '));

  let cleanPrice;
  let ytm;
  if (v.priceMode === 'yield') {
    ytm = v.priceInput;
    cleanPrice = cleanPriceFromYield(v.settle, v.maturity, v.coupon, ytm);
  } else {
    cleanPrice = v.priceInput;
    ytm = yieldFromCleanPrice(v.settle, v.maturity, v.coupon, cleanPrice);
  }
  const params = {
    settle: v.settle, maturity: v.maturity, coupon: v.coupon, cleanPrice, face: v.face,
    fxBuy: v.fxBuy, fxExit: v.fxExit, fxSpread: v.fxSpread, commissionPct: v.commission, taxRate: v.taxRate / 100,
  };
  const a = analyzeInvestment(params);
  const risk = riskMeasures(v.settle, v.maturity, v.coupon, ytm);
  const be = breakevenFx(params);
  return { v, params, cleanPrice, ytm, a, risk, be };
}

function recalc() {
  const v = readForm();
  store.set('tba.form', v);
  try {
    current = compute(v);
    $('formError').classList.add('hidden');
    $('results').style.opacity = 1;
  } catch (e) {
    $('formError').textContent = e.message;
    $('formError').classList.remove('hidden');
    $('results').style.opacity = 0.45;
    return;
  }
  renderPriceHint();
  renderAnalyze();
  syncScenarioDefaults();
  renderScenario();
}

function renderPriceHint() {
  const { v, cleanPrice, ytm } = current;
  const est = curveYield(v.settle, v.maturity);
  const other = v.priceMode === 'yield' ? `가격 ${cleanPrice.toFixed(4)}` : `수익률 ${yld(ytm)}`;
  $('priceHint').textContent = `= ${other}${est != null ? ` · 오늘 곡선 보간 수익률 ${yld(est)}` : ''}`;
}

/* ------------------------------------------------------------------ */
/* 채권 분석 탭                                                        */
/* ------------------------------------------------------------------ */
function renderAnalyze() {
  const { v, a, risk, be, ytm, cleanPrice } = current;
  $('kInvest').textContent = won(a.investKRW);
  $('kInvestUsd').textContent = `${usd(a.buyUSD)} × ${fxf(a.buyFx)}원`;
  $('kYtm').textContent = yld(ytm);
  $('kIrr').textContent = pct(a.irrPost);
  $('kIrrPre').textContent = `세전 ${pct(a.irrPre)} · 달러 기준 ${pct(a.irrUSD)}`;
  $('kBe').textContent = Number.isFinite(be) ? `${fxf(be)}원` : '-';
  $('kBeNote').textContent = Number.isFinite(be) ? `만기 환율이 이보다 낮으면 세후 손실 (매수 대비 ${pctS(be / v.fxBuy - 1, 1)})` : '';
  $('horizonLabel').textContent = `${v.settle} → ${a.exitDate} (${a.years.toFixed(1)}년), 만기 환율 ${fxf(v.fxExit)}원`;

  // 손익 분해
  const rows = [
    ['이자 수익', a.breakdown.couponKRW, '받는 이표 합계 (매수 환율 환산)'],
    ['가격 손익', a.breakdown.capitalKRW, '액면 상환 − 매수 금액(경과이자·수수료 포함)'],
    ['환율 손익', a.breakdown.fxKRW, '환율 변동 + 환전 스프레드 효과'],
    ['세금', a.breakdown.taxKRW, '이자소득세'],
  ];
  const max = Math.max(...rows.map((r) => Math.abs(r[1])), 1);
  const bar = (x) => {
    const w = (Math.abs(x) / max) * 50;
    return `<div class="bd-bar ${x >= 0 ? 'pos' : 'neg'}" style="left:${x >= 0 ? 50 : 50 - w}%;width:${Math.max(w, 0.4)}%"></div>`;
  };
  $('breakdown').innerHTML = rows.map(([l, x, t]) => `<div class="bd-row" title="${t}"><span class="lbl">${l}</span><div class="bd-track">${bar(x)}</div><span class="val ${cls(x)}">${wonS(x)}</span></div>`).join('')
    + `<div class="bd-row total"><span class="lbl">세후 순이익</span><div class="bd-track">${bar(a.profitPost)}</div><span class="val">${wonS(a.profitPost)} <small class="muted">(${pctS(a.returnPost, 1)})</small></span></div>`;

  const units = v.face / 100;
  const facts = [
    ['매수 가격 (clean)', cleanPrice.toFixed(4)],
    ['경과이자', `${usd(a.accruedPer100 * units)}`],
    ['결제 금액', usd(a.buyUSD)],
    ['잔존 만기', `${a.years.toFixed(2)}년`],
    ['매컬리 듀레이션', `${risk.macaulay.toFixed(2)}년`],
    ['수정 듀레이션', risk.modified.toFixed(2)],
    ['컨벡시티', risk.convexity.toFixed(1)],
    ['DV01 (1bp당)', usd(risk.dv01 * units)],
    ['총 이표 수령', usd(a.couponUSD)],
    ['세후 회수 원화', won(a.netKRW)],
  ];
  $('facts').innerHTML = facts.map(([k, x]) => `<div><dt>${k}</dt><dd>${x}</dd></div>`).join('');

  // 환율 시나리오
  const steps = [-0.2, -0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2];
  const pts = steps.map((s) => ({ fx: v.fxBuy * (1 + s), tag: s === 0 ? '매수 환율' : '' }));
  const same = pts.find((p) => Math.abs(p.fx - v.fxExit) < 0.005);
  if (same) { same.hl = true; same.tag = same.tag ? `${same.tag}·입력값` : '입력값'; } else pts.push({ fx: v.fxExit, tag: '입력값', hl: true });
  if (Number.isFinite(be)) pts.push({ fx: be, tag: '손익분기' });
  pts.sort((x, y) => x.fx - y.fx);
  const fxRows = pts.map((p) => {
    const r = analyzeInvestment({ ...current.params, fxExit: p.fx });
    return `<tr class="${p.hl ? 'hl' : ''}"><td>${fxf(p.fx)}원 ${p.tag ? `<span class="tag ${p.tag === '손익분기' ? 'warn' : 'ok'}">${p.tag}</span>` : ''}</td><td>${pctS(p.fx / v.fxBuy - 1, 1)}</td><td class="${cls(r.profitPre)}">${wonS(r.profitPre)}</td><td class="${cls(r.profitPost)}">${wonS(r.profitPost)}</td><td class="${cls(r.returnPost)}">${pctS(r.returnPost, 1)}</td><td class="${cls(r.irrPost)}">${pct(r.irrPost)}</td></tr>`;
  });
  $('fxTable').innerHTML = `<thead><tr><th>만기 환율</th><th>매수 대비</th><th>세전 손익</th><th>세후 손익</th><th>세후 총수익률</th><th>세후 연수익률</th></tr></thead><tbody>${fxRows.join('')}</tbody>`;

  // 연도별 이자 + 종합과세
  const LIMIT = 20000000;
  const yrs = couponsByYear(a.flows);
  $('yearTable').innerHTML = `<thead><tr><th>연도</th><th>이표 (USD)</th><th>원화 환산</th><th>다른 금융소득</th><th>합계</th><th>2,000만 원 기준</th></tr></thead><tbody>${
    yrs.map((y) => {
      const tot = y.krw + v.otherIncome;
      const over = tot > LIMIT;
      return `<tr class="${over ? 'warn' : ''}"><td>${y.year}</td><td>${usd(y.usd)}</td><td>${won(y.krw)}</td><td>${won(v.otherIncome)}</td><td>${won(tot)}</td><td>${over ? `<span class="tag warn">초과 ${won(tot - LIMIT)}</span>` : `<span class="tag ok">이하</span>`}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="left muted">회수일까지 받는 이표가 없어요.</td></tr>'
  }</tbody>`;

  // 현금흐름
  const kind = { coupon: '이표', principal: '원금 상환', sale: '매도' };
  $('cfTable').innerHTML = `<thead><tr><th>날짜</th><th>구분</th><th>USD</th><th>적용 환율</th><th>원화</th><th>세금</th><th>세후 원화</th></tr></thead><tbody>`
    + `<tr><td>${a.settle}</td><td class="left">매수</td><td class="neg">${usd(-a.buyUSD)}</td><td>${fxf(a.buyFx)}</td><td class="neg">${won(-a.investKRW)}</td><td></td><td class="neg">${won(-a.investKRW)}</td></tr>`
    + a.flows.map((f) => `<tr><td>${f.date}</td><td class="left">${kind[f.kind]}</td><td>${usd(f.usd)}</td><td>${fxf(f.fx)}</td><td>${won(f.krw)}</td><td>${f.tax ? won(-f.tax) : ''}</td><td>${won(f.krw - f.tax)}</td></tr>`).join('')
    + '</tbody>';
}

/* ------------------------------------------------------------------ */
/* 시나리오 탭                                                         */
/* ------------------------------------------------------------------ */
let scTouched = false;
function syncScenarioDefaults() {
  const { v } = current;
  const exit = $('scExit').value;
  if (!scTouched || !exit || exit <= v.settle || exit >= v.maturity) {
    let d = iso(addMonths(v.settle, 12));
    if (d >= v.maturity) {
      const mid = new Date((toDate(v.settle).getTime() + toDate(v.maturity).getTime()) / 2);
      d = iso(mid);
    }
    $('scExit').value = d;
  }
  if (!scTouched || !$('scFx').value) $('scFx').value = v.fxBuy;
  $('scExit').min = iso(new Date(toDate(v.settle).getTime() + 86400000));
  $('scExit').max = iso(new Date(toDate(v.maturity).getTime() - 86400000));
}

function scenarioAt(exitDate, shiftBp, fx) {
  const { params, ytm } = current;
  return analyzeInvestment({ ...params, exitDate, exitYield: ytm + shiftBp / 100, fxExit: fx });
}

function renderScenario() {
  if (!current) return;
  const { v, ytm } = current;
  const exit = $('scExit').value;
  const fx = Number($('scFx').value) || v.fxBuy;
  const shift = Number($('scShift').value);
  $('scShiftOut').textContent = bp(shift);
  $('scBond').textContent = `쿠폰 ${v.coupon}% · ${v.maturity} 만기 · 매수 YTM ${yld(ytm)}`;
  if (!exit || exit <= v.settle || exit >= v.maturity) {
    $('scOut').textContent = '매도일은 매수일과 만기일 사이여야 해요.';
    return;
  }

  const base = riskMeasures(exit, v.maturity, v.coupon, ytm);
  const basePrice = cleanPriceFromYield(exit, v.maturity, v.coupon, ytm);
  const sel = scenarioAt(exit, shift, fx);
  $('scOut').innerHTML = `가격 ${sel.exitInfo.clean.toFixed(3)} · 세후 <span class="${cls(sel.profitPost)}">${wonS(sel.profitPost)} (${pctS(sel.returnPost, 1)}, 연 ${pct(sel.irrPost)})</span>`;

  // 금리 변동 표
  const shifts = [-200, -150, -100, -50, 0, 50, 100, 150, 200];
  if (!shifts.includes(shift)) shifts.push(shift);
  shifts.sort((a, b) => a - b);
  $('rateTable').innerHTML = `<thead><tr><th>수익률 변화</th><th>매도 수익률</th><th>매도 가격</th><th>가격 변화</th><th>듀레이션 근사</th><th>세후 총수익률</th><th>세후 연수익률</th></tr></thead><tbody>${
    shifts.map((s) => {
      const r = scenarioAt(exit, s, fx);
      const dy = s / 10000;
      const exact = r.exitInfo.clean / basePrice - 1;
      const dirtyBase = base.dirty;
      const approx = ((-base.modified * dy + 0.5 * base.convexity * dy * dy) * dirtyBase) / basePrice;
      return `<tr class="${s === shift ? 'hl' : ''}"><td>${bp(s)}</td><td>${yld(ytm + s / 100)}</td><td>${r.exitInfo.clean.toFixed(3)}</td><td class="${cls(exact)}">${pctS(exact)}</td><td>${pctS(approx)}</td><td class="${cls(r.returnPost)}">${pctS(r.returnPost, 1)}</td><td class="${cls(r.irrPost)}">${pct(r.irrPost)}</td></tr>`;
    }).join('')
  }</tbody>`;

  // 가격-수익률 곡선
  const xs = [];
  for (let s = -300; s <= 300; s += 25) xs.push(s);
  const actual = xs.map((s) => ({ x: ytm + s / 100, y: cleanPriceFromYield(exit, v.maturity, v.coupon, ytm + s / 100) }));
  const ai = accruedInterest(exit, v.maturity, v.coupon);
  const tangent = xs.map((s) => ({ x: ytm + s / 100, y: base.dirty * (1 - base.modified * (s / 10000)) - ai }));
  const selPt = [{ x: ytm + shift / 100, y: cleanPriceFromYield(exit, v.maturity, v.coupon, ytm + shift / 100) }];
  chart('pyChart', {
    type: 'line',
    data: {
      datasets: [
        lineDs('실제 가격', actual, C.s1),
        lineDs('듀레이션 직선 근사', tangent, C.muted, { borderDash: [5, 4], borderWidth: 1.5 }),
        lineDs('선택 시나리오', selPt, C.s2, { pointRadius: 6, pointHoverRadius: 7, showLine: false, pointBorderColor: '#fff', pointBorderWidth: 2 }),
      ],
    },
    options: {
      parsing: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: axis({ type: 'linear', title: { display: true, text: '매도 시 수익률 (%)', color: C.muted }, ticks: { color: C.muted, callback: (t) => `${Number(t).toFixed(1)}` } }),
        y: axis({ title: { display: true, text: '가격 (액면 100당)', color: C.muted } }),
      },
      plugins: { tooltip: { callbacks: { title: (it) => `수익률 ${it[0].parsed.x.toFixed(3)}%`, label: (it) => `${it.dataset.label}: ${it.parsed.y.toFixed(3)}` } } },
    },
  });
  $('pyNote').textContent = `매도일 ${exit} 기준. 수정 듀레이션 ${base.modified.toFixed(2)}: 수익률이 1%p 오르면 가격이 약 ${base.modified.toFixed(1)}% 내려가고, 곡선이 직선보다 위에 있는 만큼(볼록성) 실제 손실은 조금 작고 이익은 조금 큽니다.`;

  // 매트릭스
  const rowsBp = [-200, -150, -100, -50, 0, 50, 100, 150, 200];
  const colsFx = [-0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15];
  const cells = rowsBp.map((s) => colsFx.map((c) => scenarioAt(exit, s, v.fxBuy * (1 + c)).returnPost));
  const mx = Math.max(...cells.flat().map(Math.abs), 0.0001);
  $('matrix').innerHTML = `<thead><tr><th>수익률 \\ 환율</th>${colsFx.map((c) => `<th>${pctS(c, 0)}<br><small>${nf0.format(v.fxBuy * (1 + c))}원</small></th>`).join('')}</tr></thead><tbody>${
    rowsBp.map((s, i) => `<tr><td>${bp(s)}</td>${cells[i].map((x, j) => {
      const { bg, ink } = divergingColor(x / mx);
      return `<td class="${s === 0 && colsFx[j] === 0 ? 'base' : ''}" style="background:${bg};color:${ink}" title="수익률 ${bp(s)}, 환율 ${pctS(colsFx[j], 0)} → 세후 ${pctS(x, 1)}">${pctS(x, 1)}</td>`;
    }).join('')}</tr>`).join('')
  }</tbody>`;
}

/** -1..1 → 빨강(손실) - 회색 - 파랑(이익) */
function divergingColor(t) {
  const neg = ['#f0efec', '#f6c9c4', '#ef9a93', '#e2665f', '#d03b3b'];
  const pos = ['#f0efec', '#cde2fb', '#9ec5f4', '#5598e7', '#1c5cab'];
  const a = Math.min(1, Math.abs(t));
  const idx = Math.min(4, Math.round(a * 4));
  const bg = (t < 0 ? neg : pos)[idx];
  return { bg, ink: idx >= 3 ? '#ffffff' : C.ink };
}

/* ------------------------------------------------------------------ */
/* 수익률 곡선 탭                                                      */
/* ------------------------------------------------------------------ */
const CMP = { 0: ['현재', C.s1], 7: ['1주 전', C.s2], 30: ['1개월 전', C.s3], 90: ['3개월 전', C.s4], 365: ['1년 전', C.s5], custom: ['비교일', C.s6] };
function renderCurve() {
  if (!M.hasCurve) {
    $('curveDate').textContent = '데이터 없음';
    return;
  }
  const last = M.latestRow();
  $('curveDate').textContent = `${last[0]} 기준`;
  const series = [{ key: 0, row: last }];
  document.querySelectorAll('#curveCompare input[type=checkbox]:checked').forEach((c) => {
    const r = M.rowDaysAgo(Number(c.value));
    if (r) series.push({ key: Number(c.value), row: r });
  });
  const custom = $('curveCustom').value;
  if (custom) { const r = M.rowOnOrBefore(custom); if (r) series.push({ key: 'custom', row: r }); }

  chart('curveChart', {
    type: 'line',
    data: {
      labels: M.tenors,
      datasets: series.map((s) => lineDs(`${CMP[s.key][0]} (${s.row[0]})`, M.curveOf(s.row), CMP[s.key][1], {
        pointRadius: s.key === 0 ? 3 : 2, borderWidth: s.key === 0 ? 2.5 : 1.5, spanGaps: true,
      })),
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: axis({ title: { display: true, text: '잔존 만기', color: C.muted } }), y: axis({ ticks: { color: C.muted, callback: (t) => `${Number(t).toFixed(1)}%` } }) },
      plugins: { tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${it.parsed.y?.toFixed(2)}%` } } },
    },
  });

  const head = `<thead><tr><th>구분</th>${M.tenors.map((t) => `<th>${t}</th>`).join('')}</tr></thead>`;
  const body = series.map((s, i) => {
    const vals = `<tr${i === 0 ? ' class="hl"' : ''}><td>${CMP[s.key][0]} <small class="muted">${s.row[0]}</small></td>${M.curveOf(s.row).map((x) => `<td>${x == null ? '-' : x.toFixed(2)}</td>`).join('')}</tr>`;
    if (i === 0) return vals;
    const diff = `<tr><td class="muted">　현재와 차이</td>${M.curveOf(last).map((x, j) => {
      const o = M.curveOf(s.row)[j];
      const d = x != null && o != null ? (x - o) * 100 : null;
      return `<td class="${d > 0 ? 'neg' : d < 0 ? 'pos' : ''}">${d == null ? '-' : bp(d)}</td>`;
    }).join('')}</tr>`;
    return vals + diff;
  }).join('');
  $('curveTable').innerHTML = head + `<tbody>${body}</tbody>`;
  renderHistory();
  $('curveSource').innerHTML = `출처: ${esc(M.yields.source)}${M.fxData ? ` · 환율: ${esc(M.fxData.seriesSource || '')}` : ''}. 금리 상승은 채권 가격 하락이므로 표에서 빨간색으로 표시합니다.`;
}

function renderHistory() {
  const days = Number(document.querySelector('input[name=hr]:checked').value);
  const last = M.latestRow();
  const from = new Date(last[0] + 'T00:00:00Z');
  from.setUTCDate(from.getUTCDate() - days);
  const fromIso = from.toISOString().slice(0, 10);
  const rows = M.rows.filter((r) => r[0] >= fromIso);
  const pts = (t) => rows.map((r) => ({ x: r[0], y: M.value(r, t) }));
  const timeAxis = axis({ type: 'category', ticks: { color: C.muted, maxTicksLimit: 8, maxRotation: 0, callback(v) { return String(this.getLabelForValue(v)).slice(0, 7); } } });
  const labels = rows.map((r) => r[0]);
  chart('histChart', {
    type: 'line',
    data: {
      labels,
      datasets: [
        lineDs('2년', pts('2Y').map((p) => p.y), C.s1),
        lineDs('10년', pts('10Y').map((p) => p.y), C.s2),
        lineDs('30년', pts('30Y').map((p) => p.y), C.s3),
      ],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: timeAxis, y: axis({ ticks: { color: C.muted, callback: (t) => `${Number(t).toFixed(1)}%` } }) },
      plugins: { tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${it.parsed.y?.toFixed(2)}%` } } },
    },
  });
  chart('spreadChart', {
    type: 'line',
    data: {
      labels,
      datasets: [
        lineDs('10Y−2Y', rows.map((r) => { const a = M.value(r, '10Y'); const b = M.value(r, '2Y'); return a != null && b != null ? Math.round((a - b) * 100) : null; }), C.s1, { fill: { target: { value: 0 }, above: 'rgba(42,120,214,0.12)', below: 'rgba(208,59,59,0.14)' } }),
      ],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: timeAxis, y: axis({ ticks: { color: C.muted, callback: (t) => `${t}bp` } }) },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (it) => `금리차 ${bp(it.parsed.y)}` } } },
    },
  });
  const fxRows = M.fxSeries.filter((r) => r[0] >= fromIso);
  chart('fxChart', {
    type: 'line',
    data: { labels: fxRows.map((r) => r[0]), datasets: [lineDs('USD/KRW', fxRows.map((r) => r[1]), C.s5)] },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: timeAxis, y: axis({ ticks: { color: C.muted, callback: (t) => nf0.format(t) } }) },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (it) => `${fxf(it.parsed.y)}원` } } },
    },
  });
}

/* ------------------------------------------------------------------ */
/* 포트폴리오 탭                                                       */
/* ------------------------------------------------------------------ */
let portfolio = store.get('tba.portfolio', []);
function savePf() { store.set('tba.portfolio', portfolio); $('pfCount').textContent = portfolio.length; }

function addToPortfolio() {
  if (!current) return;
  const { v, cleanPrice, ytm, a } = current;
  const name = picked ? `${picked.term} ${picked.coupon.toFixed(3)}% ${picked.maturityDate.slice(0, 4)}` : `UST ${v.coupon}% ${v.maturity.slice(0, 4)}`;
  portfolio.push({
    id: Date.now().toString(36), name, cusip: picked?.cusip || '', settle: v.settle, maturity: v.maturity,
    coupon: v.coupon, cleanPrice, ytm, face: v.face, fxBuy: v.fxBuy, fxSpread: v.fxSpread,
    commission: v.commission, taxRate: v.taxRate, buyUSD: a.buyUSD, investKRW: a.investKRW,
  });
  savePf();
  renderPortfolio();
  const btn = $('addPf');
  btn.textContent = '추가했어요 ✓';
  setTimeout(() => { btn.textContent = '포트폴리오에 추가'; }, 1500);
}

function valueNow(h, today, fxNow) {
  if (h.maturity <= today) return { matured: true };
  const asOf = today > h.settle ? today : h.settle;
  const units = h.face / 100;
  const est = curveYield(asOf, h.maturity);
  const y = est ?? h.ytm;
  const clean = cleanPriceFromYield(asOf, h.maturity, h.coupon, y);
  const ai = accruedInterest(asOf, h.maturity, h.coupon);
  const r = riskMeasures(asOf, h.maturity, h.coupon, y);
  const mvUSD = units * (clean + ai);
  return { clean, y, mvUSD, mvKRW: mvUSD * fxNow, mod: r.modified, estimated: est != null };
}

function renderPortfolio() {
  $('pfCount').textContent = portfolio.length;
  const today = todayLocal();
  const fxNow = M?.fx?.rate || current?.v.fxBuy || 1400;
  if (!portfolio.length) {
    $('pfTable').innerHTML = '<tbody><tr><td class="left muted">아직 담은 채권이 없어요. \'채권 분석\' 탭에서 계산한 뒤 "포트폴리오에 추가"를 누르세요.</td></tr></tbody>';
    $('pfKpis').innerHTML = '';
    charts.pfCfChart?.destroy(); charts.pfTaxChart?.destroy();
    return;
  }
  const vals = portfolio.map((h) => valueNow(h, today, fxNow));
  $('pfTable').innerHTML = `<thead><tr><th>종목</th><th>매수일</th><th>만기</th><th>쿠폰</th><th>액면</th><th>매수가</th><th>매수 YTM</th><th>투자 원금</th><th>추정 평가액</th><th>평가 손익</th><th></th></tr></thead><tbody>${
    portfolio.map((h, i) => {
      const val = vals[i];
      const pl = val.mvKRW != null ? val.mvKRW - h.investKRW : null;
      return `<tr><td>${esc(h.name)}${h.cusip ? `<br><small class="muted">${h.cusip}</small>` : ''}</td><td>${h.settle}</td><td>${h.maturity}</td><td>${h.coupon}%</td><td>${usd(h.face)}</td><td>${h.cleanPrice.toFixed(3)}</td><td>${yld(h.ytm)}</td><td>${won(h.investKRW)}</td><td>${val.matured ? '만기 도래' : `${won(val.mvKRW)}<br><small class="muted">가격 ${val.clean.toFixed(3)}</small>`}</td><td class="${cls(pl)}">${pl == null ? '-' : wonS(pl)}</td><td><button class="x" data-del="${h.id}" aria-label="삭제">×</button></td></tr>`;
    }).join('')
  }</tbody>`;

  const live = portfolio.map((h, i) => ({ h, v: vals[i] })).filter((x) => !x.v.matured);
  const invest = portfolio.reduce((s, h) => s + h.investKRW, 0);
  const mv = live.reduce((s, x) => s + x.v.mvKRW, 0);
  const investLive = live.reduce((s, x) => s + x.h.investKRW, 0);
  const wYtm = live.reduce((s, x) => s + x.h.ytm * x.h.buyUSD, 0) / (live.reduce((s, x) => s + x.h.buyUSD, 0) || 1);
  const wDur = live.reduce((s, x) => s + x.v.mod * x.v.mvUSD, 0) / (live.reduce((s, x) => s + x.v.mvUSD, 0) || 1);
  const in12 = iso(addMonths(today, 12));
  let next12 = 0;
  for (const { h } of live) for (const cf of cashflows(today > h.settle ? today : h.settle, h.maturity, h.coupon, h.face)) if (cf.date <= in12) next12 += cf.coupon;
  $('pfKpis').innerHTML = [
    ['총 투자 원금', won(invest), `${portfolio.length}개 종목`],
    ['추정 평가액', won(mv), `현재 곡선·환율 ${fxf(fxNow)}원 기준`],
    ['평가 손익', wonS(mv - investLive), pctS(investLive ? mv / investLive - 1 : NaN, 1)],
    ['가중 매수 YTM / 수정 듀레이션', `${yld(wYtm, 2)} / ${wDur.toFixed(1)}`, `향후 12개월 이표 ${usd(next12)}`],
  ].map(([k, b, s]) => `<div class="kpi"><span>${k}</span><b>${b}</b><small>${s}</small></div>`).join('');

  // 연도별 현금흐름
  const byYear = new Map();
  for (const { h } of live) {
    for (const cf of cashflows(today > h.settle ? today : h.settle, h.maturity, h.coupon, h.face)) {
      const y = cf.date.slice(0, 4);
      const e = byYear.get(y) || { c: 0, p: 0 };
      e.c += cf.coupon; e.p += cf.principal;
      byYear.set(y, e);
    }
  }
  const years = [...byYear.keys()].sort();
  chart('pfCfChart', {
    type: 'bar',
    data: {
      labels: years,
      datasets: [
        { label: '이표', data: years.map((y) => byYear.get(y).c), backgroundColor: C.s1, borderColor: '#fcfcfb', borderWidth: { top: 2 }, stack: 's' },
        { label: '원금 상환', data: years.map((y) => byYear.get(y).p), backgroundColor: C.s2, borderColor: '#fcfcfb', borderWidth: { top: 2 }, stack: 's' },
      ],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: axis({ stacked: true, grid: { display: false } }), y: axis({ stacked: true, ticks: { color: C.muted, callback: (t) => `$${nf0.format(t)}` } }) },
      plugins: { tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${usd(it.parsed.y)}` } } },
    },
  });
  const other = Number($('otherIncome').value) || 0;
  chart('pfTaxChart', {
    type: 'bar',
    data: {
      labels: years,
      datasets: [
        { label: '이 포트폴리오 이자', data: years.map((y) => byYear.get(y).c * fxNow), backgroundColor: C.s1, borderColor: '#fcfcfb', borderWidth: { top: 2 }, stack: 's', order: 2 },
        { label: '다른 금융소득', data: years.map(() => other), backgroundColor: C.s3, borderColor: '#fcfcfb', borderWidth: { top: 2 }, stack: 's', order: 2, hidden: !other },
        { type: 'line', label: '종합과세 기준 2,000만 원', data: years.map(() => 20000000), borderColor: C.bad, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, order: 1 },
      ],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: axis({ stacked: true, grid: { display: false } }), y: axis({ stacked: true, ticks: { color: C.muted, callback: (t) => `${nf0.format(t / 10000)}만` } }) },
      plugins: { tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${won(it.parsed.y)}` } } },
    },
  });
}

/* ------------------------------------------------------------------ */
/* 이벤트                                                              */
/* ------------------------------------------------------------------ */
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'curve') renderCurve();
  if (name === 'scenario') renderScenario();
  if (name === 'portfolio') renderPortfolio();
  history.replaceState(null, '', `#${name}`);
}

function bind() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  let timer;
  const deb = () => { clearTimeout(timer); timer = setTimeout(recalc, 150); };
  $('bondForm').addEventListener('input', (e) => { if (e.target.id !== 'search') deb(); });
  $('bondForm').addEventListener('change', (e) => {
    if (e.target.name === 'priceMode' && current) {
      $('priceInput').value = e.target.value === 'yield' ? current.ytm.toFixed(4) : current.cleanPrice.toFixed(4);
    }
    if (['maturity', 'coupon'].includes(e.target.id) && picked && ($('maturity').value !== picked.maturityDate || Number($('coupon').value) !== picked.coupon)) setPicked(null);
    if (e.target.id !== 'search') recalc();
  });

  $('search').addEventListener('input', renderSuggest);
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggest(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggest(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const items = [...$('suggest').querySelectorAll('li[data-cusip]')];
      const li = items[Math.max(sugIdx, 0)];
      if (li) choose(li.dataset.cusip);
    } else if (e.key === 'Escape') $('suggest').classList.add('hidden');
  });
  $('suggest').addEventListener('mousedown', (e) => { const li = e.target.closest('li[data-cusip]'); if (li) { e.preventDefault(); choose(li.dataset.cusip); } });
  $('search').addEventListener('blur', () => setTimeout(() => $('suggest').classList.add('hidden'), 100));

  $('fromCurve').addEventListener('click', () => {
    const est = curveYield($('settle').value, $('maturity').value);
    if (est == null) { $('priceHint').textContent = '수익률 곡선 데이터가 없어 추정할 수 없어요.'; return; }
    document.querySelector('input[name=priceMode][value=yield]').checked = true;
    $('priceInput').value = est.toFixed(3);
    recalc();
  });
  $('addPf').addEventListener('click', addToPortfolio);
  $('resetForm').addEventListener('click', () => { writeForm(defaults()); scTouched = false; recalc(); });

  ['scExit', 'scFx'].forEach((id) => $(id).addEventListener('input', () => { scTouched = true; renderScenario(); }));
  $('scShift').addEventListener('input', renderScenario);

  $('curveCompare').addEventListener('change', renderCurve);
  $('histRange').addEventListener('change', renderHistory);

  $('pfTable').addEventListener('click', (e) => {
    const id = e.target.dataset?.del;
    if (!id) return;
    portfolio = portfolio.filter((h) => h.id !== id);
    savePf(); renderPortfolio();
  });
  $('pfExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ version: 1, exported: new Date().toISOString(), holdings: portfolio }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `treasury-portfolio-${todayLocal()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('pfImport').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const list = Array.isArray(j) ? j : j.holdings;
      if (!Array.isArray(list)) throw new Error();
      const ok = list.filter((h) => h && h.settle && h.maturity && Number.isFinite(h.coupon) && Number.isFinite(h.cleanPrice) && Number.isFinite(h.face));
      portfolio = portfolio.concat(ok.map((h) => ({ ...h, id: h.id || Math.random().toString(36).slice(2) })));
      savePf(); renderPortfolio();
    } catch {
      alert('포트폴리오 파일 형식이 올바르지 않아요.');
    }
    e.target.value = '';
  });
  $('pfClear').addEventListener('click', () => {
    if (portfolio.length && confirm('포트폴리오를 모두 지울까요?')) { portfolio = []; savePf(); renderPortfolio(); }
  });
}

/* ------------------------------------------------------------------ */
/* 시작                                                                */
/* ------------------------------------------------------------------ */
async function init() {
  M = await loadData();
  renderMarket();
  renderNotice();
  const saved = store.get('tba.form', null);
  const d = defaults();
  const v = saved ? { ...d, ...saved, settle: saved.settle || d.settle } : d;
  if (saved && !saved.fxBuy) v.fxBuy = d.fxBuy;
  writeForm(v);
  bind();
  recalc();
  savePf();
  const tab = location.hash.slice(1);
  if (['analyze', 'scenario', 'curve', 'portfolio', 'guide'].includes(tab)) showTab(tab);
}

init();
