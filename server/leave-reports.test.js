import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './index.js';

async function fixture(t) {
  const app = createApp({ dbPath: ':memory:', seed: false, today: () => '2026-11-09' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, path, body) {
    const response = await fetch(base + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function employee(overrides = {}) {
    const result = await request('POST', '/api/employees', { name: '통계 직원', department: '요양팀', joinDate: '2020-01-01', allowanceMode: 'manual', annualAllowance: 30, asOf: '2026-11-09', ...overrides });
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
  }
  async function record(employeeId, startDate, overrides = {}) {
    const result = await request('POST', '/api/requests/record-used', { employeeId, startDate, type: 'annual', ...overrides });
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
  }
  async function register(employeeId, startDate, overrides = {}) {
    const result = await request('POST', '/api/requests', { employeeId, startDate, endDate: startDate, type: 'annual', ...overrides });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.status, 'approved'); return result.body;
  }
  async function reports(query = '?asOf=2026-11-09&month=2026-11') {
    const result = await request('GET', '/api/leave-reports' + query);
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  function insertStored(employeeId, startDate, endDate, days, { type = 'annual', status = 'approved', policy = 'calendar' } = {}) {
    app.locals.db.prepare(`INSERT INTO requests(employee_id,start_date,end_date,type,days,reason,status,created_at,review_note,day_policy)
      VALUES(?,?,?,?,?,'보존된 자료 통계 검증',?,'2026-11-09T00:00:00.000Z','',?)`).run(employeeId, startDate, endDate, type, days, status, policy);
  }
  return { app, request, employee, record, register, reports, insertStored };
}

test('empty reports return the selected dates, zero totals and no invented percentage', async t => {
  const { reports } = await fixture(t);
  const result = await reports('');
  assert.equal(result.asOf, '2026-11-09');
  assert.equal(result.month, '2026-11');
  assert.deepEqual(result.employees, []);
  assert.deepEqual(result.teams, []);
  assert.equal(result.summary.employeeCount, 0);
  assert.equal(result.summary.annualAllowance, 0);
  assert.equal(result.summary.usedDays, 0);
  assert.equal(result.summary.monthUsedDays, 0);
  assert.equal(result.summary.usageRate, null);
});

test('team and overall usage percentages use summed allowances rather than averaging personal rates', async t => {
  const { employee, record, register, reports } = await fixture(t);
  const first = await employee({ name: '요양 하나', annualAllowance: 15 });
  const second = await employee({ name: '요양 둘', annualAllowance: 25 });
  const nurse = await employee({ name: '간호 직원', department: '간호팀', annualAllowance: 20 });
  await record(first.id, '2026-11-01', { endDate: '2026-11-06' });
  await record(second.id, '2026-11-01', { endDate: '2026-11-05' });
  await record(nurse.id, '2026-11-07', { endDate: '2026-11-08' });
  await register(first.id, '2026-11-08', { type: 'half_pm' });
  const result = await reports();
  const team = result.teams.find(row => row.department === '요양팀');
  assert.equal(team.employeeCount, 2);
  assert.equal(team.annualAllowance, 40);
  assert.equal(team.usedDays, 11.5);
  assert.equal(team.pendingDays, 0);
  assert.equal(team.remainingDays, 28.5);
  assert.equal(team.usageRate, 28.8);
  assert.equal(team.monthUsedDays, 11.5);
  assert.equal(team.monthUsedEmployeeCount, 2);
  assert.equal(result.employees.find(row => row.id === first.id).usageRate, 43.3);
  assert.equal(result.employees.find(row => row.id === second.id).usageRate, 20);
  assert.equal(result.summary.annualAllowance, 60);
  assert.equal(result.summary.usedDays, 13.5);
  assert.equal(result.summary.usageRate, 22.5);
  assert.equal(result.summary.monthUsedEmployeeCount, 3);
});

test('monthly team participation counts one employee once and excludes cancelled and rejected leave from usage', async t => {
  const { employee, record, register, request, reports, insertStored } = await fixture(t);
  const person = await employee();
  const other = await employee({ name: '다른 직원' });
  await record(person.id, '2026-11-08', { type: 'half_am' });
  await record(person.id, '2026-11-08', { type: 'half_pm' });
  const cancelled = await record(person.id, '2026-11-07');
  await request('PATCH', `/api/requests/${cancelled.id}`, { status: 'cancelled' });
  // A rejection from a previous app version remains an audit-only row.
  insertStored(person.id, '2026-11-06', '2026-11-06', 1, { status: 'rejected' });
  await register(other.id, '2026-11-09');
  const result = await reports();
  assert.equal(result.summary.usedDays, 2);
  assert.equal(result.summary.monthUsedDays, 2);
  assert.equal(result.summary.monthPendingDays, 0);
  assert.equal(result.summary.monthUsedEmployeeCount, 2);
  assert.equal(result.teams[0].monthUsedEmployeeCount, 2);
});

test('monthly report clips legacy weekdays, includes holidays and weekend halves, and spans earlier anniversary periods', async t => {
  const { employee, record, reports, insertStored } = await fixture(t);
  const person = await employee({ joinDate: '2020-07-12', annualAllowance: 50 });
  insertStored(person.id, '2026-10-30', '2026-11-02', 2, { policy: 'weekdays' });
  await record(person.id, '2026-10-09');
  await record(person.id, '2026-11-08', { type: 'half_am' });
  await record(person.id, '2026-03-03');
  const october = await reports('?asOf=2026-11-09&month=2026-10');
  const november = await reports();
  const march = await reports('?asOf=2026-11-09&month=2026-03');
  assert.equal(october.employees[0].monthUsedDays, 2);
  assert.equal(october.summary.monthUsedDays, 2);
  assert.equal(november.summary.monthUsedDays, 1.5);
  assert.equal(november.employees[0].usedDays, 3.5);
  assert.equal(march.employees[0].monthUsedDays, 1);
  assert.equal(march.employees[0].periodStart, '2026-07-12');
  assert.equal(march.employees[0].usedDays, 3.5);
});

test('accrual references follow completed original-day monthly anchors and annual anniversaries', async t => {
  const { employee, reports } = await fixture(t);
  const person = await employee({ name: '월말 입사', joinDate: '2026-01-31', allowanceMode: 'auto' });
  const future = await employee({ name: '입사 예정', joinDate: '2027-01-31', allowanceMode: 'auto' });
  const leap = await employee({ name: '윤일 입사', joinDate: '2024-02-29', allowanceMode: 'auto' });
  for (const [asOf, accrualDate, nextAccrualDate, amount, kind] of [
    ['2026-02-27', null, '2026-02-28', 0, 'none'],
    ['2026-02-28', '2026-02-28', '2026-03-31', 1, 'monthly'],
    ['2026-03-30', '2026-02-28', '2026-03-31', 1, 'monthly'],
    ['2026-03-31', '2026-03-31', '2026-04-30', 2, 'monthly'],
    ['2027-01-31', '2027-01-31', '2028-01-31', 15, 'annual'],
  ]) {
    const result = await reports(`?asOf=${asOf}&month=${asOf.slice(0, 7)}`);
    const row = result.employees.find(item => item.id === person.id);
    assert.equal(row.accrualDate, accrualDate, asOf);
    assert.equal(row.lastAccrualDate, accrualDate, asOf);
    assert.equal(row.nextAccrualDate, nextAccrualDate, asOf);
    assert.equal(row.annualAllowance, amount, asOf);
    assert.equal(row.grantDateType, kind, asOf);
  }
  const beforeHire = (await reports()).employees.find(item => item.id === future.id);
  assert.equal(beforeHire.accrualDate, null);
  assert.equal(beforeHire.grantDateType, 'none');
  assert.equal(beforeHire.nextAccrualDate, '2027-02-28');
  const leapRow = (await reports('?asOf=2026-02-28&month=2026-02')).employees.find(item => item.id === leap.id);
  assert.equal(leapRow.accrualDate, '2026-02-28');
  assert.equal(leapRow.grantDateType, 'annual');
});

test('zero allowances return a null percentage and historical overuse remains visible above one hundred percent', async t => {
  const { employee, reports, insertStored } = await fixture(t);
  const zero = await employee({ name: '부여 없음', annualAllowance: 0 });
  const one = await employee({ name: '기존 초과 사용', annualAllowance: 1 });
  insertStored(zero.id, '2026-11-01', '2026-11-01', 0.5, { type: 'half_am' });
  insertStored(one.id, '2026-11-01', '2026-11-02', 2);
  const result = await reports();
  const zeroRow = result.employees.find(row => row.id === zero.id);
  const overdrawn = result.employees.find(row => row.id === one.id);
  assert.equal(zeroRow.usageRate, null);
  assert.equal(zeroRow.remainingDays, -0.5);
  assert.equal(overdrawn.usageRate, 200);
  assert.equal(overdrawn.remainingDays, -1);
  assert.equal(result.summary.usageRate, 250);
});

test('blank legacy departments are grouped as unassigned without changing stored data', async t => {
  const { app, employee, reports } = await fixture(t);
  const person = await employee({ department: '임시팀' });
  app.locals.db.prepare('UPDATE employees SET department = ? WHERE id = ?').run('  ', person.id);
  const counts = () => ['employees', 'requests', 'allowances'].map(table => app.locals.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  const before = counts();
  const result = await reports();
  assert.equal(result.teams[0].department, '미지정');
  assert.equal(result.employees[0].department, '미지정');
  assert.equal(result.summary.employeeCount, 1);
  assert.deepEqual(counts(), before);
  assert.equal(app.locals.db.prepare('SELECT department FROM employees WHERE id = ?').get(person.id).department, '  ');
});

test('report date validation rejects malformed and repeated parameters instead of accepting partial input', async t => {
  const { request } = await fixture(t);
  for (const query of [
    '?asOf=2026-02-30', '?asOf=2026-01-01&asOf=2026-02-01', '?asOf=',
    '?month=2026-00', '?month=2026-13', '?month=2026-1', '?month=2026-11&month=2026-10', '?month=',
    '?month=1899-12', '?month=2101-01',
  ]) {
    const result = await request('GET', '/api/leave-reports' + query);
    assert.equal(result.status, 400, `${query}: ${JSON.stringify(result.body)}`);
    assert.equal(typeof result.body.error, 'string');
  }
});
