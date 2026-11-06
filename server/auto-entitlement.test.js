import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from './index.js';

async function fixture(t, { dbPath = ':memory:', now = '2026-11-06' } = {}) {
  let clock = now;
  const app = createApp({ dbPath, seed: false, today: () => clock });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, path, body) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function employee(overrides = {}) {
    const result = await request('POST', '/api/employees', { name: '자동 연차 직원', department: '운영팀', joinDate: '2023-07-12', allowanceMode: 'auto', ...overrides });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  }
  async function snapshot(asOf = clock) {
    const result = await request('GET', `/api/bootstrap?asOf=${asOf}`);
    assert.equal(result.status, 200);
    return result.body;
  }
  async function leave(employeeId, startDate, overrides = {}) {
    return request('POST', '/api/requests', { employeeId, startDate, endDate: startDate, type: 'annual', ...overrides });
  }
  return { app, request, employee, snapshot, leave, setToday(value) { clock = value; } };
}

test('entitlement preview shares anniversary metadata and rejects invalid dates with client errors', async t => {
  const { request } = await fixture(t);
  const preview = await request('GET', '/api/entitlement?joinDate=2020-07-12&asOf=2026-11-06');
  assert.equal(preview.status, 200);
  assert.equal(preview.body.automaticAllowance, 17);
  assert.equal(preview.body.completedYears, 6);
  assert.equal(preview.body.periodStart, '2026-07-12');
  assert.equal(preview.body.periodEnd, '2027-07-11');
  assert.equal(preview.body.allowanceYear, 2026);
  assert.equal(preview.body.nextAccrualDate, '2027-07-12');
  assert.equal((await request('GET', '/api/entitlement?joinDate=1980-01-01&asOf=2026-11-06')).body.automaticAllowance, 25);
  for (const path of ['/api/entitlement', '/api/entitlement?joinDate=2026-02-30', '/api/entitlement?joinDate=2024-01-01&asOf=invalid']) {
    const result = await request('GET', path);
    assert.equal(result.status, 400);
    assert.equal(typeof result.body.error, 'string');
  }
});

test('registration without manual days is automatic and profile edits do not freeze or reset the calculation', async t => {
  const { app, request, employee, snapshot } = await fixture(t);
  const staff = await employee();
  assert.equal(staff.allowanceMode, 'auto');
  assert.equal(staff.annualAllowance, 16);
  assert.equal(staff.automaticAllowance, 16);
  assert.equal(staff.completedYears, 3);
  assert.equal(staff.priorManualAllowance, null);
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM allowances').get().count, 0);
  const edited = await request('PATCH', `/api/employees/${staff.id}`, { name: '이름만 변경' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.annualAllowance, 16);
  assert.equal(edited.body.allowanceMode, 'auto');
  assert.equal((await snapshot('2028-07-12')).employees[0].annualAllowance, 17);
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM allowances').get().count, 0);
  const implicit = await request('POST', '/api/employees', { name: '방식 생략', department: '운영팀', joinDate: '2020-07-12' });
  assert.equal(implicit.body.allowanceMode, 'auto');
  assert.equal(implicit.body.annualAllowance, 17);
});

test('first-year bootstrap accrues monthly with the selected date and resets to fifteen on the first anniversary', async t => {
  const { employee, snapshot } = await fixture(t);
  await employee({ joinDate: '2026-07-12' });
  for (const [asOf, allowance] of [['2026-07-11', 0], ['2026-08-11', 0], ['2026-08-12', 1], ['2026-11-06', 3], ['2026-11-12', 4], ['2027-07-11', 11], ['2027-07-12', 15]]) {
    const staff = (await snapshot(asOf)).employees[0];
    assert.equal(staff.annualAllowance, allowance, asOf);
    assert.equal(staff.automaticAllowance, allowance, asOf);
  }
});

test('manual adjustments preserve their values across auto toggles and unadjusted new cycles still calculate automatically', async t => {
  const { request, employee, snapshot } = await fixture(t);
  const staff = await employee();
  let changed = await request('PATCH', `/api/employees/${staff.id}`, { allowanceMode: 'manual', annualAllowance: 20, asOf: '2026-11-06' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.annualAllowance, 20);
  assert.equal(changed.body.automaticAllowance, 16);
  assert.equal(changed.body.hasManualOverride, true);
  changed = await request('PATCH', `/api/employees/${staff.id}`, { allowanceMode: 'auto', asOf: '2026-11-06' });
  assert.equal(changed.body.annualAllowance, 16);
  assert.equal(changed.body.priorManualAllowance, 20);
  changed = await request('PATCH', `/api/employees/${staff.id}`, { allowanceMode: 'manual', asOf: '2026-11-06' });
  assert.equal(changed.body.annualAllowance, 20);
  const next = (await snapshot('2028-07-12')).employees[0];
  assert.equal(next.annualAllowance, 17);
  assert.equal(next.hasManualOverride, false);
  assert.equal(next.priorManualAllowance, null);
});

test('new hires cannot reserve monthly credits that have not accrued yet, while known future annual quotas remain available', async t => {
  const { employee, request, leave, setToday } = await fixture(t);
  const staff = await employee({ joinDate: '2026-11-01' });
  assert.equal(staff.annualAllowance, 0);
  assert.equal((await leave(staff.id, '2026-12-01')).status, 409);
  setToday('2026-12-01');
  const earned = await leave(staff.id, '2026-12-01');
  assert.equal(earned.status, 201, JSON.stringify(earned.body));
  assert.equal((await leave(staff.id, '2026-12-02')).status, 409);
  assert.equal((await leave(staff.id, '2026-11-02')).status, 409);
  const veteran = await employee({ joinDate: '2024-01-01' });
  const future = await leave(veteran.id, '2027-01-04');
  assert.equal(future.status, 201, JSON.stringify(future.body));
  assert.equal((await request('PATCH', `/api/requests/${future.body.id}`, { status: 'approved' })).status, 200);
});

test('legacy SQLite migration creates a verified original snapshot and preserves staff, manual rows, and approved leave', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'onhyu-auto-migration-'));
  const path = join(directory, 'leave.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE employees(id INTEGER PRIMARY KEY,name TEXT NOT NULL,department TEXT NOT NULL,position TEXT NOT NULL DEFAULT '',join_date TEXT NOT NULL);
    CREATE TABLE allowances(employee_id INTEGER NOT NULL REFERENCES employees(id),year INTEGER NOT NULL,days REAL NOT NULL,PRIMARY KEY(employee_id,year));
    CREATE TABLE requests(id INTEGER PRIMARY KEY,employee_id INTEGER NOT NULL REFERENCES employees(id),start_date TEXT NOT NULL,end_date TEXT NOT NULL,type TEXT NOT NULL,days REAL NOT NULL,reason TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,review_note TEXT NOT NULL DEFAULT '');
    INSERT INTO employees VALUES(1,'기존 직원','운영팀','매니저','2026-11-01');
    INSERT INTO allowances VALUES(1,2026,15);
    INSERT INTO requests VALUES(1,1,'2026-11-02','2026-11-02','annual',1,'보존할 사유','approved','2026-11-01T00:00:00Z','보존할 메모');
  `);
  old.close();
  const { app, request, snapshot } = await fixture(t, { dbPath: path });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backup = app.locals.migrationBackupPath;
  assert.ok(backup && backup.startsWith(path + '.before-auto-'));
  assert.equal((await readdir(directory)).filter(name => name.includes('.before-auto-')).length, 1);
  const saved = new DatabaseSync(backup, { readOnly: true });
  try {
    assert.equal(saved.prepare('SELECT name FROM employees WHERE id=1').get().name, '기존 직원');
    assert.equal(saved.prepare('SELECT days FROM allowances').get().days, 15);
    assert.equal(saved.prepare('SELECT review_note FROM requests').get().review_note, '보존할 메모');
    assert.equal(saved.prepare('PRAGMA table_info(employees)').all().some(row => row.name === 'allowance_mode'), false);
  } finally { saved.close(); }
  let data = await snapshot();
  assert.equal(data.employees[0].allowanceMode, 'auto');
  assert.equal(data.employees[0].annualAllowance, 0);
  assert.equal(data.employees[0].priorManualAllowance, 15);
  assert.equal(data.employees[0].usedDays, 1);
  assert.equal(data.employees[0].remainingDays, -1);
  assert.equal(data.employees[0].overdrawnDays, 1);
  assert.equal(data.requests[0].reviewNote, '보존할 메모');
  const edit = await request('PATCH', '/api/employees/1', { name: '자동 계산 후 이름 변경', allowanceMode: 'auto' });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.remainingDays, -1);
  const restored = await request('PATCH', '/api/employees/1', { allowanceMode: 'manual' });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.annualAllowance, 15);
});

test('switching to a retained manual value cannot reduce allowance below committed leave', async t => {
  const { app, employee, request, leave } = await fixture(t);
  const staff = await employee();
  app.locals.db.prepare('INSERT INTO allowances(employee_id,year,days) VALUES(?,?,?)').run(staff.id, 2026, 0);
  assert.equal((await leave(staff.id, '2026-11-09')).status, 201);
  assert.equal((await request('PATCH', `/api/employees/${staff.id}`, { allowanceMode: 'manual' })).status, 409);
  assert.equal((await request('PATCH', `/api/employees/${staff.id}`, { allowanceMode: null })).status, 400);
});
