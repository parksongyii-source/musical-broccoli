export type LedgerRecord = {
  id: number;
  type: 'annual' | 'half_am' | 'half_pm';
  days: number;
  reason: string;
  isFuture: boolean;
};

export type LedgerCell = { date: string; days: number; types: string[]; records: LedgerRecord[] };

export type LedgerEmployee = {
  id: number;
  name: string;
  department: string;
  joinDate: string;
  annualAllowance: number;
  usedDays: number;
  remainingDays: number;
  periodStart: string;
  periodEnd: string;
  monthUsedDays: number;
  cells: LedgerCell[];
};

export type LedgerResponse = {
  month: string;
  asOf: string;
  days: string[];
  employees: LedgerEmployee[];
  summary: { employeeCount: number; monthUsedDays: number; usedEmployeeCount: number };
};

export const ledgerDayCount = (days: number) => Number.isInteger(days) ? String(days) : days.toFixed(1);

const labels: Record<LedgerRecord['type'], string> = { annual: '연차', half_am: '오전 반차', half_pm: '오후 반차' };

export function ledgerCellDescription(cell: LedgerCell): string {
  if (!cell.days) return `${cell.date}: 사용 기록 없음`;
  return `${cell.date}: ${ledgerDayCount(cell.days)}일. ${cell.records.map(record =>
    `${labels[record.type] || record.type} ${ledgerDayCount(record.days)}일${record.isFuture ? ' (예정)' : ''}${record.reason ? ` · ${record.reason}` : ''}`,
  ).join(' / ')}`;
}

function csvValue(value: string | number): string {
  const text = String(value);
  const safe = /^[\s]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/gu, '""')}"`;
}

/** Exports only the displayed roster. Empty dates stay empty, with half days retained. */
export function createLedgerCsv(ledger: Pick<LedgerResponse, 'month' | 'asOf' | 'days'>, employees: readonly LedgerEmployee[]): string {
  const rows: (string | number)[][] = [[
    '이름', '팀', '입사일', '연차 기간 시작', '연차 사용기한', `발생일수 (${ledger.asOf} 기준)`,
    `잔여일수 (${ledger.asOf} 기준)`, `${ledger.month} 월 사용·예정 합계`, ...ledger.days,
  ]];
  for (const employee of employees) {
    const cells = new Map(employee.cells.map(cell => [cell.date, cell.days]));
    rows.push([
      employee.name, employee.department || '미지정', employee.joinDate, employee.periodStart, employee.periodEnd,
      employee.annualAllowance, employee.remainingDays, employee.monthUsedDays,
      ...ledger.days.map(date => cells.get(date) || ''),
    ]);
  }
  rows.push([
    '합계', '', '', '', '', '', '', employees.reduce((sum, employee) => sum + employee.monthUsedDays, 0),
    ...ledger.days.map(date => employees.reduce((sum, employee) => sum + (employee.cells.find(cell => cell.date === date)?.days || 0), 0) || ''),
  ]);
  return `\uFEFF${rows.map(row => row.map(csvValue).join(',')).join('\r\n')}\r\n`;
}
