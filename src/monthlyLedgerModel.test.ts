import assert from 'node:assert/strict';
import test from 'node:test';
import { createLedgerCsv, ledgerCellDescription, type LedgerEmployee } from './monthlyLedgerModel.ts';

const employee: LedgerEmployee = {
  id: 1, name: '가상직원', department: '가상팀', joinDate: '2020-02-01', annualAllowance: 17,
  usedDays: 1.5, remainingDays: 15.5, periodStart: '2026-02-01', periodEnd: '2027-01-31', monthUsedDays: 1.5,
  cells: [
    { date: '2026-11-07', days: 1, types: ['annual'], records: [{ id: 1, type: 'annual', days: 1, reason: '', isFuture: false }] },
    { date: '2026-11-08', days: 0.5, types: ['half_pm'], records: [{ id: 2, type: 'half_pm', days: 0.5, reason: '예시', isFuture: true }] },
  ],
};

test('CSV keeps weekend and half-day usage, selected-roster totals, and basis date', () => {
  const csv = createLedgerCsv({ month: '2026-11', asOf: '2026-11-10', days: ['2026-11-07', '2026-11-08', '2026-11-09'] }, [employee]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /잔여일수 \(2026-11-10 기준\)/u);
  assert.ok(csv.includes('"1.5","1","0.5",""'));
  assert.ok(csv.includes('"합계","","","","","","","1.5","1","0.5",""'));
  assert.equal(createLedgerCsv({ month: '2026-11', asOf: '2026-11-10', days: [] }, []).split('\r\n').length, 3);
});

test('CSV protects employee-supplied formula prefixes and quotes embedded CSV characters', () => {
  const csv = createLedgerCsv({ month: '2026-11', asOf: '2026-11-10', days: [] }, [{ ...employee, name: ' =2+3', department: '@SUM(1,2)"팀' }]);
  assert.ok(csv.includes('"\' =2+3","\'@SUM(1,2)""팀"'));
});

test('cell descriptions expose exact dates, half-day distinction, future status and memo', () => {
  assert.equal(ledgerCellDescription(employee.cells[1]), '2026-11-08: 0.5일. 오후 반차 0.5일 (예정) · 예시');
  assert.equal(ledgerCellDescription({ date: '2026-11-09', days: 0, types: [], records: [] }), '2026-11-09: 사용 기록 없음');
});
