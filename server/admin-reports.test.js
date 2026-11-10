import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './index.js';

const TODAY = '2026-11-10';

async function fixture(t, { dbPath = ':memory:', seed = false } = {}) {
  const app = createApp({ dbPath, seed, today: () => TODAY });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  let closed = false;
  async function stop() {
    if (closed) return;
    closed = true;
    await new Promise(resolve => server.close(resolve));
    app.locals.close();
  }
  t.after(stop);
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, path, body) {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  async function get(path) {
    const response = await request('GET', path);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  async function employee(overrides = {}) {
    const response = await request('POST', '/api/employees', {
      name: '검증 직원', department: '요양팀', position: '요양보호사',
      joinDate: '2020-01-01', allowanceMode: 'manual', annualAllowance: 30,
      asOf: TODAY, ...overrides,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  }
  async function register(employeeId, startDate, overrides = {}) {
    const response = await request('POST', '/api/requests', {
      employeeId, startDate, endDate: startDate, type: 'annual', ...overrides,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.status, 'approved');
    return response.body;
  }
  function stored(employeeId, startDate, endDate, days, { status = 'approved', type = 'annual', policy = 'calendar', reason = '이전 기록', reviewNote = '보존 메모' } = {}) {
    const result = app.locals.db.prepare(`INSERT INTO requests(employee_id,start_date,end_date,type,days,reason,status,created_at,review_note,day_policy)
      VALUES(?,?,?,?,?,?,?,'2026-10-01T03:04:05.000Z',?,?)`).run(employeeId, startDate, endDate, type, days, reason, status, reviewNote, policy);
    return Number(result.lastInsertRowid);
  }
  return { app, stop, request, get, employee, register, stored };
}

test('expiry urgency uses actual Seoul today and includes day zero and day sixty only for positive current balances', async t => {
  const { employee, stored, get } = await fixture(t);
  const lastDay = await employee({ name: '오늘 만료', joinDate: '2020-11-11' });
  const sixty = await employee({ name: '육십일 남음', joinDate: '2020-01-10' });
  const sixtyOne = await employee({ name: '육십일 초과', joinDate: '2020-01-11' });
  const zero = await employee({ name: '잔여 없음', joinDate: '2020-01-10', annualAllowance: 0 });
  const overdrawn = await employee({ name: '초과 사용', joinDate: '2020-01-10', annualAllowance: 1 });
  stored(overdrawn.id, '2026-11-01', '2026-11-02', 2);
  const futureHire = await employee({ name: '입사 예정', joinDate: '2027-01-10' });
  const report = await get('/api/leave-reports?asOf=2026-11-10');
  assert.equal(report.today, TODAY);
  assert.equal(report.urgentWindowDays, 60);
  const rows = new Map(report.employees.map(row => [row.id, row]));
  assert.deepEqual([rows.get(lastDay.id).expiryDate, rows.get(lastDay.id).daysUntilExpiry, rows.get(lastDay.id).isUrgent], ['2026-11-10', 0, true]);
  assert.deepEqual([rows.get(sixty.id).expiryDate, rows.get(sixty.id).daysUntilExpiry, rows.get(sixty.id).isUrgent], ['2027-01-09', 60, true]);
  assert.deepEqual([rows.get(sixtyOne.id).daysUntilExpiry, rows.get(sixtyOne.id).isUrgent], [61, false]);
  assert.equal(rows.get(zero.id).currentRemainingDays, 0);
  assert.equal(rows.get(zero.id).isUrgent, false);
  assert.equal(rows.get(overdrawn.id).currentRemainingDays, -1);
  assert.equal(rows.get(overdrawn.id).isUrgent, false);
  assert.equal(rows.get(futureHire.id).currentRemainingDays, 0);
  assert.equal(rows.get(futureHire.id).isUrgent, false);
  for (const asOf of ['2025-11-10', '2027-11-10']) {
    const historical = await get(`/api/leave-reports?asOf=${asOf}`);
    assert.equal(historical.today, TODAY);
    assert.ok(historical.employees.every(row => row.isUrgent === false), asOf);
    assert.equal(historical.employees.find(row => row.id === sixty.id).currentRemainingDays, 30);
  }
});

test('same-period new-hire reports expose actual current credits separately and require positive balances in both views', async t => {
  const { employee, stored, get } = await fixture(t);
  const person = await employee({ name: '첫해 월별 발생', joinDate: '2026-01-10', allowanceMode: 'auto' });
  const october = (await get('/api/leave-reports?asOf=2026-10-10')).employees.find(row => row.id === person.id);
  assert.equal(october.annualAllowance, 9);
  assert.equal(october.remainingDays, 9);
  assert.equal(october.currentRemainingDays, 10);
  assert.equal(october.daysUntilExpiry, 60);
  assert.equal(october.isUrgent, true);
  const unearned = (await get('/api/leave-reports?asOf=2026-01-10')).employees.find(row => row.id === person.id);
  assert.equal(unearned.periodStart, october.periodStart);
  assert.equal(unearned.remainingDays, 0);
  assert.equal(unearned.currentRemainingDays, 10);
  assert.equal(unearned.isUrgent, false);
  const exhausted = await employee({ name: '현재 잔여 소진', joinDate: '2026-01-10', allowanceMode: 'auto' });
  const overdrawn = await employee({ name: '현재 잔여 초과', joinDate: '2026-01-10', allowanceMode: 'auto' });
  for (const staff of [exhausted, overdrawn]) stored(staff.id, '2026-11-01', '2026-11-10', 10);
  stored(overdrawn.id, '2026-10-31', '2026-10-31', 0.5, { type: 'half_am' });
  const projected = await get('/api/leave-reports?asOf=2026-12-10');
  const zeroNow = projected.employees.find(row => row.id === exhausted.id);
  const negativeNow = projected.employees.find(row => row.id === overdrawn.id);
  assert.deepEqual([zeroNow.remainingDays, zeroNow.currentRemainingDays, zeroNow.isUrgent], [1, 0, false]);
  assert.deepEqual([negativeNow.remainingDays, negativeNow.currentRemainingDays, negativeNow.isUrgent], [0.5, -0.5, false]);
});

test('legacy pending rows are backed up before registration, preserve all other data and migrate exactly once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'onhyu-admin-upgrade-'));
  const dbPath = join(directory, 'leave.sqlite');
  const original = await fixture(t, { dbPath });
  const person = await original.employee();
  const legacy = original.stored(person.id, '2026-10-30', '2026-11-02', 2, { status: 'pending', policy: 'weekdays', reason: '기존 대기 일정' });
  original.stored(person.id, '2026-11-08', '2026-11-08', 0.5, { status: 'pending', type: 'half_pm' });
  original.stored(person.id, '2026-11-04', '2026-11-04', 1);
  original.stored(person.id, '2026-11-05', '2026-11-05', 1, { status: 'cancelled' });
  original.stored(person.id, '2026-11-06', '2026-11-06', 1, { status: 'rejected' });
  const before = original.app.locals.db.prepare('SELECT * FROM requests ORDER BY id').all().map(row => ({ ...row }));
  const committed = (await original.get(`/api/bootstrap?asOf=${TODAY}`)).employees[0];
  assert.equal(committed.usedDays + committed.pendingDays, 3.5);
  await original.stop();
  const upgraded = await fixture(t, { dbPath });
  const backupPath = upgraded.app.locals.migrationBackupPath;
  assert.match(backupPath, /\.before-admin-.*\.sqlite$/);
  const snapshot = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assert.equal(snapshot.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.deepEqual(snapshot.prepare('SELECT * FROM requests ORDER BY id').all().map(row => ({ ...row })), before);
  } finally { snapshot.close(); }
  const after = upgraded.app.locals.db.prepare('SELECT * FROM requests ORDER BY id').all().map(row => ({ ...row }));
  assert.deepEqual(after, before.map(row => ({ ...row, status: row.status === 'pending' ? 'approved' : row.status })));
  assert.equal(upgraded.app.locals.db.prepare("SELECT COUNT(*) AS count FROM requests WHERE status='pending'").get().count, 0);
  const totals = (await upgraded.get(`/api/bootstrap?asOf=${TODAY}`)).employees[0];
  assert.equal(totals.usedDays, 3.5);
  assert.equal(totals.pendingDays, 0);
  assert.equal(totals.usedDays + totals.pendingDays, committed.usedDays + committed.pendingDays);
  assert.equal(totals.remainingDays, 26.5);
  const cancelled = await upgraded.request('PATCH', `/api/requests/${legacy}`, { status: 'cancelled', reviewNote: '일정 취소' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const restored = (await upgraded.get(`/api/bootstrap?asOf=${TODAY}`)).employees[0];
  assert.equal(restored.usedDays, 1.5);
  assert.equal(restored.remainingDays, 28.5);
  await upgraded.stop();
  const reopened = await fixture(t, { dbPath });
  assert.equal(reopened.app.locals.migrationBackupPath, null);
  assert.equal((await readdir(directory)).filter(name => name.includes('.before-admin-')).length, 1);
  assert.equal((await reopened.get(`/api/bootstrap?asOf=${TODAY}`)).employees[0].usedDays, 1.5);
  await reopened.stop();
  t.after(() => rm(directory, { recursive: true, force: true }));
});

test('period history displays all thirteen calendar months, exact legacy dates, opposite halves and cross-year bookings', async t => {
  const { employee, register, stored, request, get } = await fixture(t);
  const person = await employee({ joinDate: '2020-07-12' });
  const legacy = stored(person.id, '2026-10-30', '2026-11-02', 2, { policy: 'weekdays' });
  const saturday = await register(person.id, '2026-10-31');
  const morning = await register(person.id, '2026-11-08', { type: 'half_am' });
  const afternoon = await register(person.id, '2026-11-08', { type: 'half_pm' });
  const newYear = await register(person.id, '2026-12-31', { endDate: '2027-01-02', reason: '연말 일정' });
  const cancelled = await register(person.id, '2026-11-09');
  assert.equal((await request('PATCH', `/api/requests/${cancelled.id}`, { status: 'cancelled' })).status, 200);
  const rejected = stored(person.id, '2026-11-10', '2026-11-10', 1, { status: 'rejected' });
  const previous = await register(person.id, '2026-07-11');
  const next = await register(person.id, '2027-07-12');
  const period = await get(`/api/employees/${person.id}/leave-period?asOf=${TODAY}`);
  assert.deepEqual([period.periodStart, period.periodEnd], ['2026-07-12', '2027-07-11']);
  assert.deepEqual(period.months.map(row => row.month), ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07']);
  assert.deepEqual(period.usedDates.map(row => [row.date, row.days, row.requestId]), [
    ['2026-10-30', 1, legacy], ['2026-10-31', 1, saturday.id], ['2026-11-02', 1, legacy],
    ['2026-11-08', 0.5, morning.id], ['2026-11-08', 0.5, afternoon.id],
    ['2026-12-31', 1, newYear.id], ['2027-01-01', 1, newYear.id], ['2027-01-02', 1, newYear.id],
  ]);
  assert.equal(period.records.find(row => row.id === legacy).periodDays, 2);
  assert.equal(period.records.find(row => row.id === newYear.id).periodDays, 3);
  assert.equal(period.records.find(row => row.id === cancelled.id).status, 'cancelled');
  assert.equal(period.records.find(row => row.id === rejected).status, 'rejected');
  assert.ok(period.records.every(row => ![previous.id, next.id].includes(row.id)));
  const current = (await get(`/api/bootstrap?asOf=${TODAY}`)).employees[0];
  for (const key of ['annualAllowance', 'usedDays', 'pendingDays', 'remainingDays']) assert.equal(period[key], current[key], key);
  assert.equal(period.usedDays, 7);
  assert.equal(period.usedDates.reduce((sum, row) => sum + row.days, 0), period.usedDays);
  assert.equal(period.months.reduce((sum, row) => sum + row.usedDays, 0), period.usedDays);
  assert.deepEqual(period.months.flatMap(row => row.usedDates), period.usedDates);
  const earlierPeriod = await get(`/api/employees/${person.id}/leave-period?asOf=2026-07-11`);
  assert.deepEqual(earlierPeriod.usedDates.map(row => row.requestId), [previous.id]);
});

test('monthly ledger includes all forty-four employees and reconciles exact calendar cells with reports and history', async t => {
  const { app, register, stored, request, get } = await fixture(t);
  const people = Array.from({ length: 44 }, (_, index) => ({
    name: `검증 직원 ${String(index + 1).padStart(2, '0')}`, department: index % 2 ? '간호팀' : '요양팀',
    position: '팀원', joinDate: '2020-01-01',
  }));
  const imported = await request('POST', '/api/employees/bulk', { asOf: TODAY, employees: people });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  const [one, two, three] = imported.body.employees;
  const legacy = stored(one.id, '2026-10-30', '2026-11-02', 2, { policy: 'weekdays' });
  const sunday = await register(one.id, '2026-11-01');
  const am = await register(one.id, '2026-11-08', { type: 'half_am' });
  const pm = await register(one.id, '2026-11-08', { type: 'half_pm' });
  const future = await register(two.id, '2026-11-14', { endDate: '2026-11-15' });
  const holiday = await register(three.id, '2026-10-09', { reason: '공휴일 근무자의 연차' });
  const cancelled = await register(two.id, '2026-11-09');
  assert.equal((await request('PATCH', `/api/requests/${cancelled.id}`, { status: 'cancelled' })).status, 200);
  stored(two.id, '2026-11-10', '2026-11-10', 1, { status: 'rejected' });
  const before = app.locals.db.prepare('SELECT COUNT(*) AS count FROM requests').get().count;
  const ledger = await get(`/api/leave-ledger?month=2026-11&asOf=${TODAY}`);
  assert.equal(ledger.employees.length, 44);
  assert.equal(ledger.days.length, 30);
  assert.deepEqual([ledger.days[0], ledger.days.at(-1)], ['2026-11-01', '2026-11-30']);
  assert.deepEqual(ledger.summary, { employeeCount: 44, monthUsedDays: 5, usedEmployeeCount: 2 });
  const first = ledger.employees.find(row => row.id === one.id);
  const second = ledger.employees.find(row => row.id === two.id);
  const untouched = ledger.employees.find(row => row.id === three.id);
  assert.equal(first.department, '요양팀');
  assert.equal(first.monthUsedDays, 3);
  assert.equal(second.monthUsedDays, 2);
  assert.equal(untouched.monthUsedDays, 0);
  for (const person of ledger.employees) {
    assert.deepEqual(person.cells.map(cell => cell.date), ledger.days);
    assert.equal(person.cells.reduce((sum, cell) => sum + cell.days, 0), person.monthUsedDays);
    for (const cell of person.cells) assert.equal(cell.records.reduce((sum, record) => sum + record.days, 0), cell.days);
  }
  assert.ok(untouched.cells.every(cell => cell.days === 0 && cell.records.length === 0 && cell.types.length === 0));
  assert.deepEqual(first.cells[0].records.map(row => row.id), [sunday.id]);
  assert.deepEqual(first.cells[1].records.map(row => row.id), [legacy]);
  assert.equal(first.cells[7].days, 1);
  assert.deepEqual(first.cells[7].types, ['half_am', 'half_pm']);
  assert.deepEqual(first.cells[7].records.map(row => row.id), [am.id, pm.id]);
  assert.ok(first.cells[7].records.every(row => row.isFuture === false));
  assert.deepEqual(second.cells[13].records.map(row => [row.id, row.isFuture]), [[future.id, true]]);
  assert.equal(second.cells[8].days, 0);
  assert.equal(second.cells[9].days, 0);
  const reports = await get(`/api/leave-reports?asOf=${TODAY}&month=2026-11`);
  assert.equal(reports.summary.monthUsedDays, ledger.summary.monthUsedDays);
  assert.equal(reports.summary.monthUsedEmployeeCount, ledger.summary.usedEmployeeCount);
  for (const person of [one, two, three]) {
    const history = await get(`/api/employees/${person.id}/leave-history?month=2026-11`);
    assert.equal(history.usedDays, ledger.employees.find(row => row.id === person.id).monthUsedDays);
  }
  const october = await get(`/api/leave-ledger?month=2026-10&asOf=${TODAY}`);
  assert.deepEqual(october.employees.find(row => row.id === three.id).cells[8].records.map(row => row.id), [holiday.id]);
  assert.equal(october.summary.monthUsedDays, 2);
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM requests').get().count, before);
});

test('empty ledgers retain every civil date and new read endpoints reject malformed and repeated query values', async t => {
  const { employee, request, get } = await fixture(t);
  const empty = await get('/api/leave-ledger?month=2024-02');
  assert.equal(empty.asOf, TODAY);
  assert.equal(empty.days.length, 29);
  assert.equal(empty.days.at(-1), '2024-02-29');
  assert.deepEqual(empty.employees, []);
  assert.deepEqual(empty.summary, { employeeCount: 0, monthUsedDays: 0, usedEmployeeCount: 0 });
  const person = await employee({ joinDate: '2027-01-10' });
  const beforeHire = await get(`/api/employees/${person.id}/leave-period?asOf=${TODAY}`);
  assert.equal(beforeHire.usedDays, 0);
  assert.equal(beforeHire.annualAllowance, 0);
  assert.deepEqual(beforeHire.records, []);
  assert.deepEqual(beforeHire.usedDates, []);
  for (const query of ['month=', 'month=2026-00', 'month=2026-13', 'month=2026-1', 'month=1899-12', 'month=2101-01', 'month=2026-11&month=2026-12', 'asOf=2026-02-30', 'asOf=2026-11-01&asOf=2026-11-02']) {
    const response = await request('GET', '/api/leave-ledger?' + query);
    assert.equal(response.status, 400, query);
    assert.equal(typeof response.body.error, 'string');
  }
  for (const suffix of [`${person.id}/leave-period?asOf=2026-02-30`, `${person.id}/leave-period?asOf=2026-11-01&asOf=2026-11-02`, '0/leave-period', 'bad/leave-period']) {
    assert.equal((await request('GET', '/api/employees/' + suffix)).status, 400, suffix);
  }
  assert.equal((await request('GET', '/api/employees/999999/leave-period')).status, 404);
});
