import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateEntitlement } from './entitlement.js';

test('first-year monthly credits start on completed months and stop at eleven', () => {
  const hire = '2026-07-12';
  for (const [asOf, days] of [
    ['2026-07-11', 0], ['2026-07-12', 0], ['2026-08-11', 0],
    ['2026-08-12', 1], ['2026-11-11', 3], ['2026-11-12', 4],
    ['2027-06-12', 11], ['2027-07-11', 11],
  ]) assert.equal(calculateEntitlement(hire, asOf).automaticAllowance, days, asOf);
  assert.equal(calculateEntitlement(hire, '2026-07-11').nextAccrualDate, '2026-08-12');
  assert.equal(calculateEntitlement(hire, '2027-06-12').nextAccrualDate, '2027-07-12');
});

test('first anniversary replaces monthly credits with fifteen and biennial seniority adds days', () => {
  const hire = '2020-07-12';
  for (const [asOf, days, years] of [
    ['2021-07-11', 11, 0], ['2021-07-12', 15, 1], ['2022-07-12', 15, 2],
    ['2023-07-11', 15, 2], ['2023-07-12', 16, 3], ['2024-07-12', 16, 4],
    ['2025-07-12', 17, 5], ['2040-07-12', 24, 20], ['2041-07-12', 25, 21],
    ['2060-07-12', 25, 40],
  ]) {
    const result = calculateEntitlement(hire, asOf);
    assert.equal(result.automaticAllowance, days, asOf);
    assert.equal(result.completedYears, years, asOf);
  }
  assert.equal(calculateEntitlement(hire, '2023-07-12').nextAccrualDate, '2024-07-12');
});

test('month-end accrual keeps the original hire day rather than drifting after February', () => {
  const hire = '2026-01-31';
  for (const [asOf, days] of [
    ['2026-02-27', 0], ['2026-02-28', 1], ['2026-03-28', 1],
    ['2026-03-30', 1], ['2026-03-31', 2], ['2026-04-30', 3],
    ['2026-12-31', 11], ['2027-01-30', 11], ['2027-01-31', 15],
  ]) assert.equal(calculateEntitlement(hire, asOf).automaticAllowance, days, asOf);
  assert.equal(calculateEntitlement(hire, '2026-02-28').nextAccrualDate, '2026-03-31');
  assert.equal(calculateEntitlement('2024-01-31', '2024-02-28').automaticAllowance, 0);
  assert.equal(calculateEntitlement('2024-01-31', '2024-02-29').automaticAllowance, 1);
});

test('leap-day hiring follows clamped annual anniversaries and original monthly anchors', () => {
  const hire = '2024-02-29';
  assert.equal(calculateEntitlement(hire, '2024-03-28').automaticAllowance, 0);
  assert.equal(calculateEntitlement(hire, '2024-03-29').automaticAllowance, 1);
  assert.equal(calculateEntitlement(hire, '2025-02-27').automaticAllowance, 11);
  assert.equal(calculateEntitlement(hire, '2025-02-28').automaticAllowance, 15);
  assert.equal(calculateEntitlement(hire, '2025-02-28').completedYears, 1);
  assert.equal(calculateEntitlement(hire, '2027-02-28').automaticAllowance, 16);
  assert.equal(calculateEntitlement(hire, '2028-02-28').completedYears, 3);
  assert.equal(calculateEntitlement(hire, '2028-02-28').completedMonths, 47);
  assert.equal(calculateEntitlement(hire, '2028-02-28').nextAccrualDate, '2028-02-29');
  assert.equal(calculateEntitlement(hire, '2028-02-29').completedYears, 4);
});

test('future hires have zero credits and long-tenure employees remain capped', () => {
  const future = calculateEntitlement('2027-01-01', '2026-11-06');
  assert.equal(future.automaticAllowance, 0);
  assert.equal(future.completedYears, 0);
  assert.equal(future.completedMonths, 0);
  assert.match(future.calculationBasis, /입사 전/);
  const veteran = calculateEntitlement('1980-01-01', '2026-11-06');
  assert.equal(veteran.automaticAllowance, 25);
  assert.equal(veteran.completedYears, 46);
});

test('malformed or impossible civil dates are rejected instead of rolled over', () => {
  for (const invalid of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-01-00', '2026-7-12', '0000-01-01', '9999-01-01', '', null, 20260712]) {
    assert.throws(() => calculateEntitlement(invalid, '2026-11-06'), RangeError);
    assert.throws(() => calculateEntitlement('2020-07-12', invalid), RangeError);
  }
});
