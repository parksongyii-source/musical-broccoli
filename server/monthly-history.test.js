import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './index.js';

async function fixture(t, { dbPath = ':memory:', now = '2026-11-10' } = {}) {
  const app = createApp({ dbPath, seed: false, today: () => now });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    app.locals.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, path, body) {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  async function employee(overrides = {}) {
    const result = await request('POST', '/api/employees', {
      name: '월별 조회 직원', department: '요양팀', position: '요양보호사',
      joinDate: '2020-01-01', allowanceMode: 'manual', annualAllowance: 50,
      asOf: now, ...overrides,
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  }
  async function record(employeeId, startDate, overrides = {}) {
    const result = await request('POST', '/api/requests/record-used', {
      employeeId, startDate, type: 'annual', ...overrides,
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  }
  async function pending(employeeId, startDate, overrides = {}) {
    const result = await request('POST', '/api/requests', {
      employeeId, startDate, endDate: startDate, type: 'annual', ...overrides,
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  }
  async function history(employeeId, month) {
    const result = await request('GET', `/api/employees/${employeeId}/leave-history?month=${month}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  return { app, request, employee, record, pending, history };
}

test('monthly history splits a cross-month calendar range into the dates used in each month', async t => {
  const { employee, record, history } = await fixture(t);
  const staff = await employee();
  const leave = await record(staff.id, '2026-10-30', { endDate: '2026-11-02', reason: '가족 일정' });
  assert.equal(leave.days, 4);
  assert.equal(leave.includesWeekends, true);
  const october = await history(staff.id, '2026-10');
  const november = await history(staff.id, '2026-11');
  assert.equal(october.employee.id, staff.id);
  assert.equal(october.employee.name, staff.name);
  assert.equal(october.employee.department, '요양팀');
  assert.equal(october.employee.joinDate, '2020-01-01');
  assert.equal(october.month, '2026-10');
  assert.equal(october.usedDays, 2);
  assert.equal(november.usedDays, 2);
  assert.equal(october.records[0].days, 4);
  assert.equal(october.records[0].monthDays, 2);
  assert.equal(november.records[0].monthDays, 2);
  assert.deepEqual(october.usedDates.map(row => row.date), ['2026-10-30', '2026-10-31']);
  assert.deepEqual(november.usedDates.map(row => row.date), ['2026-11-01', '2026-11-02']);
  assert.ok(october.usedDates.every(row => row.days === 1 && row.requestId === leave.id && row.reason === '가족 일정'));
});

test('Sunday half-days and a Korean public holiday are visible and included in monthly totals', async t => {
  const { employee, record, history } = await fixture(t);
  const staff = await employee();
  await record(staff.id, '2026-10-09', { reason: '한글날 근무일 연차' });
  const morning = await record(staff.id, '2026-11-08', { type: 'half_am' });
  const afternoon = await record(staff.id, '2026-11-08', { type: 'half_pm' });
  const october = await history(staff.id, '2026-10');
  const november = await history(staff.id, '2026-11');
  assert.equal(october.usedDays, 1);
  assert.deepEqual(october.usedDates.map(row => row.date), ['2026-10-09']);
  assert.equal(november.usedDays, 1);
  assert.deepEqual(november.usedDates.map(row => [row.date, row.days, row.requestId, row.type]), [
    ['2026-11-08', 0.5, morning.id, 'half_am'],
    ['2026-11-08', 0.5, afternoon.id, 'half_pm'],
  ]);
});

test('only approved dates contribute to used totals while pending, rejected and cancelled records retain their status', async t => {
  const { employee, record, pending, history, request } = await fixture(t);
  const staff = await employee();
  await record(staff.id, '2026-11-01');
  await record(staff.id, '2026-11-03', { type: 'half_am' });
  await pending(staff.id, '2026-11-04');
  const rejected = await pending(staff.id, '2026-11-05');
  assert.equal((await request('PATCH', `/api/requests/${rejected.id}`, { status: 'rejected' })).status, 200);
  const cancelled = await record(staff.id, '2026-11-06');
  assert.equal((await request('PATCH', `/api/requests/${cancelled.id}`, { status: 'cancelled' })).status, 200);
  const month = await history(staff.id, '2026-11');
  assert.equal(month.usedDays, 1.5);
  assert.equal(month.pendingDays, 1);
  assert.equal(month.records.length, 5);
  assert.deepEqual(month.records.map(row => row.status), ['approved', 'approved', 'pending', 'rejected', 'cancelled']);
  assert.deepEqual(month.usedDates.map(row => [row.date, row.days]), [['2026-11-01', 1], ['2026-11-03', 0.5]]);
});

test('monthly history is employee-specific and is not limited to the current anniversary period', async t => {
  const { employee, record, history, request } = await fixture(t);
  const staff = await employee({ joinDate: '2020-07-12', allowanceMode: 'auto' });
  const other = await employee({ name: '다른 직원' });
  const previousPeriod = await record(staff.id, '2026-07-11');
  const currentPeriod = await record(staff.id, '2026-07-13');
  await record(other.id, '2026-07-14');
  const data = await history(staff.id, '2026-07');
  assert.equal(data.usedDays, 2);
  assert.deepEqual(data.records.map(row => row.id), [previousPeriod.id, currentPeriod.id]);
  assert.ok(data.usedDates.every(row => row.requestId !== 3));
  const current = await request('GET', '/api/bootstrap?asOf=2026-11-10');
  assert.equal(current.status, 200);
  assert.equal(current.body.employees.find(row => row.id === staff.id).usedDays, 1);
  const empty = await history(staff.id, '2026-09');
  assert.equal(empty.usedDays, 0);
  assert.equal(empty.pendingDays, 0);
  assert.deepEqual(empty.records, []);
  assert.deepEqual(empty.usedDates, []);
});

test('cancelling a used record removes its daily entries and monthly used total without deleting the audit row', async t => {
  const { employee, record, history, request } = await fixture(t);
  const staff = await employee();
  const leave = await record(staff.id, '2026-11-07', { type: 'half_pm' });
  assert.equal((await history(staff.id, '2026-11')).usedDays, 0.5);
  assert.equal((await request('PATCH', `/api/requests/${leave.id}`, { status: 'cancelled' })).status, 200);
  const after = await history(staff.id, '2026-11');
  assert.equal(after.usedDays, 0);
  assert.deepEqual(after.usedDates, []);
  assert.equal(after.records.length, 1);
  assert.equal(after.records[0].status, 'cancelled');
});

test('monthly history validates month shape, range, repeated query values and employee identifiers', async t => {
  const { employee, request } = await fixture(t);
  const staff = await employee();
  for (const month of ['', '2026-00', '2026-13', '2026-1', '2026-11-01', '1899-12', '2101-01', '2026-11&month=2026-12']) {
    const response = await request('GET', `/api/employees/${staff.id}/leave-history?month=${month}`);
    assert.equal(response.status, 400, JSON.stringify(response));
    assert.equal(typeof response.body.error, 'string');
  }
  assert.equal((await request('GET', '/api/employees/0/leave-history?month=2026-11')).status, 400);
  assert.equal((await request('GET', '/api/employees/not-an-id/leave-history?month=2026-11')).status, 400);
  assert.equal((await request('GET', '/api/employees/999999/leave-history?month=2026-11')).status, 404);
});

test('legacy weekday records retain their original dates and counts while new weekend records can fill the previously excluded dates', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'onhyu-history-upgrade-'));
  const path = join(directory, 'leave.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE employees(id INTEGER PRIMARY KEY,name TEXT NOT NULL,department TEXT NOT NULL,position TEXT NOT NULL DEFAULT '',join_date TEXT NOT NULL,allowance_mode TEXT NOT NULL DEFAULT 'auto');
    CREATE TABLE allowances(employee_id INTEGER NOT NULL REFERENCES employees(id),year INTEGER NOT NULL,days REAL NOT NULL,PRIMARY KEY(employee_id,year));
    CREATE TABLE requests(id INTEGER PRIMARY KEY,employee_id INTEGER NOT NULL REFERENCES employees(id),start_date TEXT NOT NULL,end_date TEXT NOT NULL,type TEXT NOT NULL,days REAL NOT NULL,reason TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,review_note TEXT NOT NULL DEFAULT '');
    INSERT INTO employees VALUES(1,'기존 직원','요양팀','요양보호사','2020-01-01','manual');
    INSERT INTO allowances VALUES(1,2026,50);
    INSERT INTO requests VALUES(1,1,'2026-10-30','2026-11-02','annual',2,'이전 평일 계산','approved','2026-10-29T00:00:00Z','이전 메모');
  `);
  old.close();
  const { app, request, record, history } = await fixture(t, { dbPath: path });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backups = (await readdir(directory)).filter(name => name.startsWith('leave.sqlite.before-weekend-') && name.endsWith('.sqlite'));
  assert.equal(backups.length, 1);
  assert.equal(app.locals.migrationBackupPath, join(directory, backups[0]));
  const snapshot = new DatabaseSync(app.locals.migrationBackupPath, { readOnly: true });
  try {
    assert.equal(snapshot.prepare('SELECT days FROM requests WHERE id=1').get().days, 2);
    assert.equal(snapshot.prepare('SELECT review_note FROM requests WHERE id=1').get().review_note, '이전 메모');
    assert.equal(snapshot.prepare('PRAGMA table_info(requests)').all().some(column => column.name === 'day_policy'), false);
  } finally { snapshot.close(); }
  const legacy = await history(1, '2026-10');
  assert.equal(legacy.records[0].days, 2);
  assert.equal(legacy.records[0].includesWeekends, false);
  assert.equal(legacy.usedDays, 1);
  assert.deepEqual(legacy.usedDates.map(row => row.date), ['2026-10-30']);
  const saturday = await record(1, '2026-10-31');
  const sunday = await record(1, '2026-11-01', { type: 'half_am' });
  assert.equal(saturday.includesWeekends, true);
  assert.equal(sunday.includesWeekends, true);
  const blockedMonday = await request('POST', '/api/requests/record-used', { employeeId: 1, startDate: '2026-11-02', type: 'annual' });
  assert.equal(blockedMonday.status, 409);
  const october = await history(1, '2026-10');
  const november = await history(1, '2026-11');
  assert.equal(october.usedDays, 2);
  assert.deepEqual(october.usedDates.map(row => row.date), ['2026-10-30', '2026-10-31']);
  assert.equal(november.usedDays, 1.5);
  assert.deepEqual(november.usedDates.map(row => [row.date, row.days]), [['2026-11-01', 0.5], ['2026-11-02', 1]]);
  assert.equal(app.locals.db.prepare('SELECT days FROM requests WHERE id=1').get().days, 2);
});
