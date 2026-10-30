import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  couponSchedule, accruedInterest, cleanPriceFromYield, yieldFromCleanPrice,
  riskMeasures, analyzeInvestment, breakevenFx, interpolateCurve, irr, iso,
} from '../js/bond-math.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a}`);

test('이표 일정: 월말 만기는 월말 이표', () => {
  const s = couponSchedule('2029-12-01', '2030-08-31');
  assert.deepEqual(s.dates.map(iso), ['2030-02-28', '2030-08-31']);
  assert.equal(iso(s.prev), '2029-08-31');
});

test('이표 일정: 15일 만기', () => {
  const s = couponSchedule('2024-07-01', '2028-05-15');
  assert.equal(iso(s.prev), '2024-05-15');
  assert.equal(iso(s.next), '2024-11-15');
  assert.equal(s.dates.length, 8);
});

test('경과이자 Act/Act: 2.875% 2028-05-15, 결제 2024-07-01 = 47/184일', () => {
  near(accruedInterest('2024-07-01', '2028-05-15', 2.875), 1.4375 * 47 / 184, 1e-12);
});

test('이표일 결제, 수익률=쿠폰이면 가격 100', () => {
  near(cleanPriceFromYield('2025-05-15', '2035-05-15', 4.25, 4.25), 100, 1e-9);
});

test('가격 <-> 수익률 왕복', () => {
  const y = 4.1234;
  const p = cleanPriceFromYield('2026-10-30', '2036-08-15', 4.25, y);
  near(yieldFromCleanPrice('2026-10-30', '2036-08-15', 4.25, p), y, 1e-8);
});

test('30년 6% 액면채 수정듀레이션 = (1/y)(1-1.03^-60) = 13.838', () => {
  const r = riskMeasures('2020-02-15', '2050-02-15', 6, 6);
  near(r.modified, (1 / 0.06) * (1 - Math.pow(1.03, -60)), 1e-9);
  near(r.dirty, 100, 1e-9);
});

test('IRR: 100 -> 1년 뒤 110 = 10%', () => {
  near(irr([{ date: '2025-01-01', amount: -100 }, { date: '2026-01-01', amount: 110 }]), 0.10, 1e-9);
});

test('원화 분석: 환율 불변·세금 0·수수료 0이면 원화 IRR ≈ 달러 IRR, 환손익 0', () => {
  const r = analyzeInvestment({
    settle: '2025-05-15', maturity: '2030-05-15', coupon: 4, cleanPrice: 98, face: 10000,
    fxBuy: 1400, fxExit: 1400, fxSpread: 0, commissionPct: 0, taxRate: 0,
  });
  near(r.irrPre, r.irrUSD, 1e-9);
  near(r.breakdown.fxKRW, 0, 1e-6);
  // 이표 10회 * $200 + 원금 $10,000 - 매수 $9,800 = $2,200
  near(r.pnlUSD, 2200, 1e-9);
  near(r.profitPre, 2200 * 1400, 1e-6);
});

test('원화 분석: 세금은 이표에만 15.4%', () => {
  const r = analyzeInvestment({
    settle: '2025-05-15', maturity: '2027-05-15', coupon: 5, cleanPrice: 100, face: 10000,
    fxBuy: 1000, fxExit: 1000, taxRate: 0.154,
  });
  near(r.taxKRW, 4 * 250 * 1000 * 0.154, 1e-6);
});

test('원화 분석: 매수 경과이자는 첫 이표 과세표준에서 차감', () => {
  const p = { settle: '2025-08-15', maturity: '2027-05-15', coupon: 4, cleanPrice: 100, face: 10000, fxBuy: 1000, fxExit: 1000, taxRate: 0.154 };
  const r = analyzeInvestment(p);
  const ai = accruedInterest(p.settle, p.maturity, p.coupon) * 100; // USD
  near(r.taxKRW, (4 * 200 - ai) * 1000 * 0.154, 1e-6);
});

test('손익분기 환율에서 세후 손익 0', () => {
  const p = { settle: '2026-10-30', maturity: '2031-10-31', coupon: 4, cleanPrice: 99, face: 10000, fxBuy: 1400, fxExit: 1400, fxSpread: 1, taxRate: 0.154 };
  const be = breakevenFx(p);
  near(analyzeInvestment({ ...p, fxExit: be }).profitPost, 0, 1e-3);
  assert.ok(be < 1400);
});

test('중도 매도: 같은 수익률로 매도하면 달러 IRR ≈ 매수 수익률', () => {
  const settle = '2026-10-30';
  const maturity = '2036-08-15';
  const y = 4.3;
  const clean = cleanPriceFromYield(settle, maturity, 4.25, y);
  const r = analyzeInvestment({
    settle, maturity, coupon: 4.25, cleanPrice: clean, face: 10000,
    fxBuy: 1400, fxExit: 1400, taxRate: 0, exitDate: '2028-10-30', exitYield: y,
  });
  // 반기복리 y -> 연복리 환산
  near(r.irrUSD, Math.pow(1 + y / 200, 2) - 1, 2e-4);
});

test('곡선 보간', () => {
  near(interpolateCurve([1, 2, 5], [4, 4.2, 4.5], 3.5), 4.35, 1e-12);
  near(interpolateCurve([1, 2, 5], [4, null, 4.5], 3), 4.25, 1e-12);
});
