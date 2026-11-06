import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp, employmentPeriod } from './index.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'annual-leave-test-'));
  const app = createApp({ dbPath: path.join(directory, 'test.sqlite'), seed: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    app.locals.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, url, body) {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  async function employee(annualAllowance = 15, overrides = {}) {
    const result = await request('POST', '/api/employees', {
      name: '테스트 직원', department: '개발팀', position: '매니저',
      joinDate: '2024-01-01', annualAllowance, year: 2026, ...overrides,
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  }
  async function apply(employeeId, overrides = {}) {
    return request('POST', '/api/requests', {
      employeeId, startDate: '2026-11-02', endDate: '2026-11-02',
      type: 'annual', reason: '개인 일정', ...overrides,
    });
  }
  async function bootstrap(asOf = '2026-11-05') {
    const result = await request('GET', `/api/bootstrap?asOf=${asOf}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  return { app, request, employee, apply, bootstrap };
}

function assertClientError(result) {
  assert.ok(result.status >= 400 && result.status < 500, JSON.stringify(result));
  assert.equal(typeof result.body.error, 'string');
  assert.ok(result.body.error.length > 0);
}

test('fresh databases contain no employees or requests when demo seeding is disabled', async t => {
  const { bootstrap } = await fixture(t);
  const data = await bootstrap();
  assert.equal(data.year, 2026);
  assert.equal(data.asOf, '2026-11-05');
  assert.deepEqual(data.employees, []);
  assert.deepEqual(data.requests, []);
});

test('annual leave counts weekdays, reserves balance, and approval moves reserved days to used days', async t => {
  const { employee, apply, request, bootstrap } = await fixture(t);
  const staff = await employee();
  const leave = await apply(staff.id, { startDate: '2026-11-06', endDate: '2026-11-09' });
  assert.equal(leave.status, 201, JSON.stringify(leave.body));
  assert.equal(leave.body.days, 2);
  assert.equal(leave.body.status, 'pending');
  let snapshot = await bootstrap();
  assert.equal(snapshot.employees[0].pendingDays, 2);
  assert.equal(snapshot.employees[0].usedDays, 0);
  assert.equal(snapshot.employees[0].remainingDays, 15);
  const approval = await request('PATCH', `/api/requests/${leave.body.id}`, { status: 'approved' });
  assert.equal(approval.status, 200, JSON.stringify(approval.body));
  snapshot = await bootstrap();
  assert.equal(snapshot.employees[0].pendingDays, 0);
  assert.equal(snapshot.employees[0].usedDays, 2);
  assert.equal(snapshot.employees[0].remainingDays, 13);
});

test('opposite half-days can share a weekday but duplicate halves and full-day overlap cannot', async t => {
  const { employee, apply, bootstrap } = await fixture(t);
  const staff = await employee();
  const morning = await apply(staff.id, { type: 'half_am' });
  assert.equal(morning.status, 201, JSON.stringify(morning.body));
  assert.equal(morning.body.days, 0.5);
  assertClientError(await apply(staff.id, { type: 'half_am' }));
  const afternoon = await apply(staff.id, { type: 'half_pm' });
  assert.equal(afternoon.status, 201, JSON.stringify(afternoon.body));
  assert.equal(afternoon.body.days, 0.5);
  assertClientError(await apply(staff.id));
  assert.equal((await bootstrap()).employees[0].pendingDays, 1);
});

test('pending requests reserve allowance and rejection releases it', async t => {
  const { employee, apply, request, bootstrap } = await fixture(t);
  const staff = await employee(1);
  const first = await apply(staff.id);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assertClientError(await apply(staff.id, { startDate: '2026-11-03', endDate: '2026-11-03' }));
  const rejected = await request('PATCH', `/api/requests/${first.body.id}`, {
    status: 'rejected', reviewNote: '일정 재조정 필요',
  });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.reviewNote, '일정 재조정 필요');
  assert.equal((await bootstrap()).employees[0].pendingDays, 0);
  const replacement = await apply(staff.id);
  assert.equal(replacement.status, 201, JSON.stringify(replacement.body));
});

test('cancelling approved leave restores the balance and blocks unsupported state transitions', async t => {
  const { employee, apply, request, bootstrap } = await fixture(t);
  const staff = await employee(2);
  const leave = await apply(staff.id);
  assert.equal(leave.status, 201, JSON.stringify(leave.body));
  assert.equal((await request('PATCH', `/api/requests/${leave.body.id}`, { status: 'approved' })).status, 200);
  assertClientError(await request('PATCH', `/api/requests/${leave.body.id}`, { status: 'rejected' }));
  const cancelled = await request('PATCH', `/api/requests/${leave.body.id}`, { status: 'cancelled' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const data = await bootstrap();
  assert.equal(data.employees[0].usedDays, 0);
  assert.equal(data.employees[0].remainingDays, 2);
  assertClientError(await request('PATCH', `/api/requests/${leave.body.id}`, { status: 'approved' }));
});

test('invalid calendar dates, reversed ranges, cross-period requests, and nonworking half-days are rejected', async t => {
  const { employee, apply, bootstrap } = await fixture(t);
  const staff = await employee();
  for (const dates of [
    { startDate: '2026-02-30', endDate: '2026-02-30' },
    { startDate: '2026-11-04', endDate: '2026-11-02' },
    { startDate: '2026-12-31', endDate: '2027-01-01' },
    { startDate: '2026-11-07', endDate: '2026-11-07', type: 'half_am' },
    { startDate: '2026-11-02', endDate: '2026-11-03', type: 'half_pm' },
    { startDate: '2026-11-07', endDate: '2026-11-08' },
  ]) assertClientError(await apply(staff.id, dates));
  assert.deepEqual((await bootstrap()).requests, []);
});

test('allowance cannot be lowered below already approved and pending leave', async t => {
  const { employee, apply, request, bootstrap } = await fixture(t);
  const staff = await employee(3);
  const leave = await apply(staff.id, { startDate: '2026-11-02', endDate: '2026-11-03' });
  assert.equal(leave.status, 201, JSON.stringify(leave.body));
  assertClientError(await request('PATCH', `/api/employees/${staff.id}`, { annualAllowance: 1, year: 2026 }));
  assert.equal((await bootstrap()).employees[0].annualAllowance, 3);
  const updated = await request('PATCH', `/api/employees/${staff.id}`, { annualAllowance: 4, year: 2026 });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal((await bootstrap()).employees[0].annualAllowance, 4);
});

test('requests and annual allowances are isolated by each employment period', async t => {
  const { employee, apply, request, bootstrap } = await fixture(t);
  const staff = await employee(10);
  assert.equal((await apply(staff.id)).status, 201);
  assert.equal((await bootstrap('2027-11-05')).employees[0].annualAllowance, 16);
  const update = await request('PATCH', `/api/employees/${staff.id}`, { annualAllowance: 20, year: 2027 });
  assert.equal(update.status, 200, JSON.stringify(update.body));
  const current = await bootstrap('2026-11-05');
  const next = await bootstrap('2027-11-05');
  assert.equal(current.employees[0].annualAllowance, 10);
  assert.equal(next.employees[0].annualAllowance, 20);
  assert.equal(current.requests.length, 1);
  assert.equal(next.requests.length, 0);
  assert.equal(next.employees[0].pendingDays, 0);
});

test('malformed field values and unknown IDs return client errors without damaging stored data', async t => {
  const { employee, apply, request, bootstrap } = await fixture(t);
  const staff = await employee();
  assertClientError(await apply(999999));
  assertClientError(await apply(staff.id, { type: 'invalid' }));
  assertClientError(await apply(staff.id, { reason: 'x'.repeat(5000) }));
  assertClientError(await request('PATCH', '/api/requests/999999', { status: 'approved' }));
  assertClientError(await request('PATCH', `/api/employees/${staff.id}`, { annualAllowance: -1, year: 2026 }));
  assertClientError(await request('PATCH', `/api/employees/${staff.id}`, { annualAllowance: '15', year: 2026 }));
  assertClientError(await request('POST', '/api/employees', {
    name: '', department: '개발팀', position: '팀원', joinDate: 'invalid', annualAllowance: 15, year: 2026,
  }));
  const data = await bootstrap();
  assert.equal(data.employees.length, 1);
  assert.equal(data.employees[0].annualAllowance, 15);
  assert.equal(data.requests.length, 0);
});

test('leave cannot predate employment and joining dates cannot invalidate active requests', async t => {
  const { employee, apply, request, bootstrap } = await fixture(t);
  const staff = await employee(15, { joinDate: '2026-11-04' });
  assertClientError(await apply(staff.id));
  const validLeave = await apply(staff.id, { startDate: '2026-11-04', endDate: '2026-11-04' });
  assert.equal(validLeave.status, 201, JSON.stringify(validLeave.body));
  assertClientError(await request('PATCH', `/api/employees/${staff.id}`, { joinDate: '2026-11-05' }));
  assert.equal((await bootstrap()).employees[0].joinDate, '2026-11-04');
  assert.equal((await bootstrap('2025-11-05')).employees[0].annualAllowance, 0);
});

test('employee, allowance, and approved leave survive closing and reopening the SQLite database', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'annual-leave-persistence-'));
  const dbPath = path.join(directory, 'persistent.sqlite');
  let app;
  let server;
  async function start() {
    app = createApp({ dbPath, seed: false });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (method, url, body) => {
      const response = await fetch(`${base}${url}`, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
  }
  async function stop() {
    if (!server) return;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server = undefined;
    app.locals.close();
  }
  try {
    let request = await start();
    const staff = await request('POST', '/api/employees', {
      name: '저장 확인', department: '운영팀', position: '팀원',
      joinDate: '2024-01-01', annualAllowance: 17, year: 2026,
    });
    assert.equal(staff.status, 201, JSON.stringify(staff.body));
    const leave = await request('POST', '/api/requests', {
      employeeId: staff.body.id, startDate: '2026-11-02', endDate: '2026-11-02',
      type: 'half_am', reason: '저장 검증',
    });
    assert.equal(leave.status, 201, JSON.stringify(leave.body));
    assert.equal((await request('PATCH', `/api/requests/${leave.body.id}`, { status: 'approved' })).status, 200);
    await stop();
    request = await start();
    const restored = await request('GET', '/api/bootstrap?asOf=2026-11-05');
    assert.equal(restored.status, 200);
    assert.equal(restored.body.employees.length, 1);
    assert.equal(restored.body.employees[0].name, '저장 확인');
    assert.equal(restored.body.employees[0].annualAllowance, 17);
    assert.equal(restored.body.employees[0].usedDays, 0.5);
    assert.equal(restored.body.employees[0].remainingDays, 16.5);
    assert.equal(restored.body.requests[0].status, 'approved');
    assert.equal(restored.body.requests[0].reason, '저장 검증');
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('employment periods follow the joining anniversary and leap-day anniversaries clamp in nonleap years', () => {
  assert.deepEqual(employmentPeriod('2024-03-01', '2026-02-28'), {
    periodStart: '2025-03-01', periodEnd: '2026-02-28', allowanceYear: 2025, active: true,
  });
  assert.deepEqual(employmentPeriod('2024-03-01', '2026-03-01'), {
    periodStart: '2026-03-01', periodEnd: '2027-02-28', allowanceYear: 2026, active: true,
  });
  assert.deepEqual(employmentPeriod('2020-02-29', '2023-02-28'), {
    periodStart: '2023-02-28', periodEnd: '2024-02-28', allowanceYear: 2023, active: true,
  });
  assert.deepEqual(employmentPeriod('2020-02-29', '2024-02-28'), {
    periodStart: '2023-02-28', periodEnd: '2024-02-28', allowanceYear: 2023, active: true,
  });
  assert.deepEqual(employmentPeriod('2020-02-29', '2024-02-29'), {
    periodStart: '2024-02-29', periodEnd: '2025-02-27', allowanceYear: 2024, active: true,
  });
  assert.deepEqual(employmentPeriod('2020-02-29', '2025-02-28'), {
    periodStart: '2025-02-28', periodEnd: '2026-02-27', allowanceYear: 2025, active: true,
  });
  assert.deepEqual(employmentPeriod('2024-03-01', '2024-02-29'), {
    periodStart: '2024-03-01', periodEnd: '2025-02-28', allowanceYear: 2024, active: false,
  });
});

test('leave may cross December to January inside an employment period but cannot cross its anniversary', async t => {
  const { employee, apply, bootstrap } = await fixture(t);
  const staff = await employee(15, { joinDate: '2024-03-01' });
  const spanningNewYear = await apply(staff.id, {
    startDate: '2026-12-31', endDate: '2027-01-04',
  });
  assert.equal(spanningNewYear.status, 201, JSON.stringify(spanningNewYear.body));
  assert.equal(spanningNewYear.body.days, 3);
  const data = await bootstrap('2027-01-04');
  assert.equal(data.employees[0].periodStart, '2026-03-01');
  assert.equal(data.employees[0].periodEnd, '2027-02-28');
  assert.equal(data.employees[0].allowanceYear, 2026);
  assert.equal(data.employees[0].pendingDays, 3);
  assert.equal(data.requests[0].id, spanningNewYear.body.id);
  assertClientError(await apply(staff.id, { startDate: '2027-02-26', endDate: '2027-03-01' }));
});

test('the anniversary selects new allowance and excludes the previous employment period history and balances', async t => {
  const { employee, apply, request, bootstrap } = await fixture(t);
  const staff = await employee(10, { joinDate: '2024-03-01', year: 2025 });
  const allowanceUpdate = await request('PATCH', `/api/employees/${staff.id}`, { annualAllowance: 20, allowanceYear: 2026 });
  assert.equal(allowanceUpdate.status, 200, JSON.stringify(allowanceUpdate.body));
  const previousLeave = await apply(staff.id, { startDate: '2026-02-27', endDate: '2026-02-27' });
  assert.equal(previousLeave.status, 201, JSON.stringify(previousLeave.body));
  assert.equal((await request('PATCH', `/api/requests/${previousLeave.body.id}`, { status: 'approved' })).status, 200);
  const previous = await bootstrap('2026-02-28');
  assert.equal(previous.employees[0].annualAllowance, 10);
  assert.equal(previous.employees[0].usedDays, 1);
  assert.equal(previous.employees[0].remainingDays, 9);
  assert.equal(previous.requests.length, 1);
  const reset = await bootstrap('2026-03-01');
  assert.equal(reset.employees[0].annualAllowance, 20);
  assert.equal(reset.employees[0].usedDays, 0);
  assert.equal(reset.employees[0].pendingDays, 0);
  assert.equal(reset.employees[0].remainingDays, 20);
  assert.equal(reset.requests.length, 0);
  const newLeave = await apply(staff.id, { startDate: '2026-03-02', endDate: '2026-03-02' });
  assert.equal(newLeave.status, 201, JSON.stringify(newLeave.body));
  assert.equal((await request('PATCH', `/api/requests/${newLeave.body.id}`, { status: 'approved' })).status, 200);
  const current = await bootstrap('2026-03-01');
  assert.equal(current.employees[0].usedDays, 1);
  assert.equal(current.employees[0].remainingDays, 19);
  assert.deepEqual(current.requests.map(row => row.id), [newLeave.body.id]);
  assert.equal((await bootstrap('2026-02-28')).employees[0].remainingDays, 9);
});

test('editing future staff preserves configured allowance while usable allowance stays zero before hiring', async t => {
  const { request, bootstrap } = await fixture(t);
  const created = await request('POST', '/api/employees', {
    name: '입사 예정 직원', department: '개발팀', position: '매니저',
    joinDate: '2027-03-01', annualAllowance: 15, asOf: '2026-11-05',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.annualAllowance, 0);
  assert.equal(created.body.configuredAllowance, 15);
  assert.equal(created.body.allowanceYear, 2027);
  const before = (await bootstrap('2026-11-05')).employees[0];
  assert.equal(before.configuredAllowance, 15);
  const updated = await request('PATCH', `/api/employees/${before.id}`, {
    name: '이름 수정 직원', annualAllowance: before.configuredAllowance,
    allowanceYear: before.allowanceYear, asOf: '2026-11-05',
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.name, '이름 수정 직원');
  assert.equal(updated.body.annualAllowance, 0);
  assert.equal(updated.body.configuredAllowance, 15);
  const joined = (await bootstrap('2027-03-01')).employees[0];
  assert.equal(joined.annualAllowance, 15);
  assert.equal(joined.configuredAllowance, 15);
  assert.equal(joined.remainingDays, 15);
});
