import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarDays, createApp } from './index.js';

async function fixture(t, now = '2026-11-06') {
  const app = createApp({ dbPath: ':memory:', seed: false, today: () => now });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, path, body) {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  async function employee(overrides = {}) {
    const result = await request('POST', '/api/employees', {
      name: '사용 기록 직원', department: '요양팀', joinDate: '2023-07-12',
      allowanceMode: 'auto', ...overrides,
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  }
  async function snapshot(asOf = now) {
    const result = await request('GET', `/api/bootstrap?asOf=${asOf}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  async function record(employeeId, startDate, overrides = {}) {
    return request('POST', '/api/requests/record-used', { employeeId, startDate, type: 'annual', ...overrides });
  }
  async function apply(employeeId, startDate, overrides = {}) {
    return request('POST', '/api/requests', { employeeId, startDate, endDate: startDate, type: 'annual', ...overrides });
  }
  function countRequests() { return app.locals.db.prepare('SELECT COUNT(*) AS count FROM requests').get().count; }
  return { app, request, employee, snapshot, record, apply, countRequests };
}

test('saving a used date immediately approves and deducts leave without creating a pending request', async t => {
  const { employee, record, snapshot } = await fixture(t);
  const staff = await employee();
  const saved = await record(staff.id, '2026-11-06', { reason: '  병원 방문  ' });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.employeeId, staff.id);
  assert.equal(saved.body.employeeName, staff.name);
  assert.equal(saved.body.startDate, '2026-11-06');
  assert.equal(saved.body.endDate, '2026-11-06');
  assert.equal(saved.body.days, 1);
  assert.equal(saved.body.status, 'approved');
  assert.equal(saved.body.reason, '병원 방문');
  assert.equal(saved.body.reviewNote, '관리자 사용 기록');
  const data = await snapshot();
  assert.equal(data.employees[0].usedDays, 1);
  assert.equal(data.employees[0].pendingDays, 0);
  assert.equal(data.employees[0].remainingDays, staff.annualAllowance - 1);
  assert.equal(data.requests[0].id, saved.body.id);
});

test('used ranges count every selected calendar day including Saturday and Sunday', async t => {
  const { employee, record, snapshot } = await fixture(t, '2026-11-10');
  const staff = await employee();
  const saved = await record(staff.id, '2026-11-06', { endDate: '2026-11-09' });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.days, 4);
  const data = await snapshot();
  assert.equal(data.employees[0].usedDays, 4);
  assert.equal(data.employees[0].remainingDays, staff.annualAllowance - 4);
});

test('Saturday and Sunday support annual leave, morning half-days, and afternoon half-days', async t => {
  const { employee, record, snapshot } = await fixture(t, '2026-11-10');
  for (const date of ['2026-11-07', '2026-11-08']) {
    for (const type of ['annual', 'half_am', 'half_pm']) {
      const staff = await employee({ name: `${date} ${type}` });
      const saved = await record(staff.id, date, { type });
      assert.equal(saved.status, 201, `${date} ${type}: ${JSON.stringify(saved.body)}`);
      const expectedDays = type === 'annual' ? 1 : 0.5;
      assert.equal(saved.body.days, expectedDays);
      const actual = (await snapshot()).employees.find(row => row.id === staff.id);
      assert.equal(actual.usedDays, expectedDays);
      assert.equal(actual.remainingDays, staff.annualAllowance - expectedDays);
    }
  }
});

test('ordinary pending requests also allow weekend ranges and opposite weekend half-days', async t => {
  const { employee, apply, snapshot } = await fixture(t);
  const staff = await employee();
  const weekend = await apply(staff.id, '2026-11-07', { endDate: '2026-11-08' });
  assert.equal(weekend.status, 201, JSON.stringify(weekend.body));
  assert.equal(weekend.body.status, 'pending');
  assert.equal(weekend.body.days, 2);
  const second = await employee();
  assert.equal((await apply(second.id, '2026-11-08', { type: 'half_am' })).status, 201);
  assert.equal((await apply(second.id, '2026-11-08', { type: 'half_pm' })).status, 201);
  assert.equal((await apply(second.id, '2026-11-08', { type: 'half_am' })).status, 409);
  assert.equal((await apply(second.id, '2026-11-08')).status, 409);
  const data = await snapshot();
  assert.equal(data.employees[0].pendingDays, 2);
  assert.equal(data.employees[1].pendingDays, 1);
});

test('invalid used dates and identifiers return client errors without saving any records', async t => {
  const { employee, record, countRequests } = await fixture(t);
  const staff = await employee();
  for (const [id, date, options, status] of [
    [staff.id, '2026-11-07', {}, 400],
    [staff.id, '2026-11-05', { endDate: '2026-11-07' }, 400],
    [staff.id, '2026-02-30', {}, 400],
    [staff.id, '2026-11-05', { endDate: '2026-11-04' }, 400],
    [staff.id, '2026-11-04', { endDate: '2026-11-05', type: 'half_am' }, 400],
    [staff.id, '2026-11-05', { type: 'sick' }, 400],
    [staff.id, '2026-11-05', { reason: 'x'.repeat(501) }, 400],
    ['1 OR 1=1', '2026-11-05', {}, 400],
    [0, '2026-11-05', {}, 400],
    [999999, '2026-11-05', {}, 404],
  ]) {
    const result = await record(id, date, options);
    assert.equal(result.status, status, JSON.stringify(result));
    assert.equal(typeof result.body.error, 'string');
    assert.equal(countRequests(), 0);
  }
});

test('used leave cannot predate hiring or cross the employee anniversary', async t => {
  const { employee, record, countRequests } = await fixture(t);
  const newHire = await employee({ joinDate: '2026-11-04', allowanceMode: 'manual', annualAllowance: 15 });
  assert.equal((await record(newHire.id, '2026-11-03')).status, 400);
  const veteran = await employee({ joinDate: '2023-11-04' });
  assert.equal((await record(veteran.id, '2026-11-03', { endDate: '2026-11-05' })).status, 400);
  assert.equal(countRequests(), 0);
});

test('pending reservations and approved used leave both consume the available allowance', async t => {
  const { employee, record, apply, request, snapshot, countRequests } = await fixture(t);
  const staff = await employee({ allowanceMode: 'manual', annualAllowance: 1 });
  const pending = await apply(staff.id, '2026-11-04');
  assert.equal(pending.status, 201, JSON.stringify(pending.body));
  assert.equal((await record(staff.id, '2026-11-03')).status, 409);
  assert.equal(countRequests(), 1);
  assert.equal((await request('PATCH', `/api/requests/${pending.body.id}`, { status: 'rejected' })).status, 200);
  assert.equal((await record(staff.id, '2026-11-03')).status, 201);
  assert.equal((await record(staff.id, '2026-11-04')).status, 409);
  const data = await snapshot();
  assert.equal(data.employees[0].usedDays, 1);
  assert.equal(data.employees[0].pendingDays, 0);
  assert.equal(data.employees[0].remainingDays, 0);
  assert.equal(countRequests(), 2);
});

test('new-hire used records use credits earned on the actual date and respect manual adjustments', async t => {
  const { employee, record, snapshot, countRequests } = await fixture(t);
  const staff = await employee({ joinDate: '2026-07-12' });
  assert.equal(staff.annualAllowance, 3);
  assert.equal((await record(staff.id, '2026-07-13')).status, 409);
  assert.equal((await record(staff.id, '2026-08-12', { endDate: '2026-08-13' })).status, 409);
  assert.equal(countRequests(), 0);
  for (const date of ['2026-08-12', '2026-09-12', '2026-10-12']) {
    const saved = await record(staff.id, date);
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
  }
  assert.equal((await record(staff.id, '2026-11-02')).status, 409);
  assert.equal((await snapshot()).employees[0].remainingDays, 0);
  const adjusted = await employee({ joinDate: '2026-07-12', allowanceMode: 'manual', annualAllowance: 5 });
  const saved = await record(adjusted.id, '2026-07-13', { endDate: '2026-07-14' });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.days, 2);
  assert.equal((await snapshot()).employees[1].remainingDays, 3);
});

test('backdated new-hire records use chronological monthly credits instead of charging later leave against an earlier month', async t => {
  const { employee, record, snapshot } = await fixture(t, '2026-11-09');
  const staff = await employee({ joinDate: '2026-07-12' });
  assert.equal((await record(staff.id, '2026-10-12', { endDate: '2026-10-13' })).status, 201);
  const earlier = await record(staff.id, '2026-08-12');
  assert.equal(earlier.status, 201, JSON.stringify(earlier.body));
  assert.equal((await snapshot()).employees[0].usedDays, 3);
  assert.equal((await snapshot()).employees[0].remainingDays, 0);
  // Spending a second August day exceeds the single monthly credit available
  // on that date even though the employee earns more in later months.
  const second = await employee({ joinDate: '2026-07-12' });
  assert.equal((await record(second.id, '2026-10-12')).status, 201);
  assert.equal((await record(second.id, '2026-08-12')).status, 201);
  const invalidEarlier = await record(second.id, '2026-08-13');
  assert.equal(invalidEarlier.status, 409, JSON.stringify(invalidEarlier.body));
  assert.equal((await snapshot()).employees[1].usedDays, 2);
});

test('weekend overlaps with pending and approved leave are blocked while opposite halves can share a date', async t => {
  const { employee, record, apply } = await fixture(t, '2026-11-10');
  const staff = await employee();
  assert.equal((await apply(staff.id, '2026-11-07')).status, 201);
  assert.equal((await record(staff.id, '2026-11-07')).status, 409);
  assert.equal((await record(staff.id, '2026-11-06', { endDate: '2026-11-09' })).status, 409);
  const second = await employee();
  assert.equal((await record(second.id, '2026-11-08', { type: 'half_am' })).status, 201);
  assert.equal((await record(second.id, '2026-11-08', { type: 'half_am' })).status, 409);
  assert.equal((await apply(second.id, '2026-11-08', { type: 'half_am' })).status, 409);
  assert.equal((await record(second.id, '2026-11-08', { type: 'half_pm' })).status, 201);
  assert.equal((await record(second.id, '2026-11-08')).status, 409);
  assert.equal((await apply(second.id, '2026-11-08')).status, 409);
});

test('cancelling an immediately approved weekend half-day restores balance and allows a corrected record', async t => {
  const { employee, record, request, snapshot } = await fixture(t, '2026-11-10');
  const staff = await employee({ allowanceMode: 'manual', annualAllowance: 2 });
  const saved = await record(staff.id, '2026-11-07', { type: 'half_pm' });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal((await snapshot()).employees[0].remainingDays, 1.5);
  const cancelled = await request('PATCH', `/api/requests/${saved.body.id}`, { status: 'cancelled', reviewNote: '날짜 수정' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.status, 'cancelled');
  const data = await snapshot();
  assert.equal(data.employees[0].usedDays, 0);
  assert.equal(data.employees[0].remainingDays, 2);
  assert.equal((await record(staff.id, '2026-11-07', { type: 'half_pm' })).status, 201);
});

test('recording an earlier anniversary period leaves the current period balance unchanged', async t => {
  const { employee, record, snapshot } = await fixture(t);
  const staff = await employee({ joinDate: '2023-11-04' });
  const saved = await record(staff.id, '2026-11-03');
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const current = await snapshot('2026-11-06');
  assert.equal(current.employees[0].usedDays, 0);
  assert.equal(current.requests.length, 0);
  const earlier = await snapshot('2026-11-03');
  assert.equal(earlier.employees[0].usedDays, 1);
  assert.equal(earlier.requests[0].id, saved.body.id);
});

test('existing stored weekday-based counts remain unchanged when new records include weekend days', async t => {
  const { app, employee, record, snapshot } = await fixture(t, '2026-11-10');
  const staff = await employee();
  app.locals.db.prepare(`INSERT INTO requests(employee_id,start_date,end_date,type,days,reason,status,created_at,day_policy)
    VALUES(?,?,?,'annual',2,'기존 기록','approved','2026-10-01T00:00:00.000Z','weekdays')`).run(staff.id, '2026-10-02', '2026-10-05');
  const saved = await record(staff.id, '2026-11-06', { endDate: '2026-11-09' });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const data = await snapshot();
  assert.equal(data.employees[0].usedDays, 6);
  assert.equal(data.requests.find(row => row.reason === '기존 기록').days, 2);
  assert.equal(data.requests.find(row => row.id === saved.body.id).days, 4);
});

test('a legacy weekday-only pending range can be approved after recording its unoccupied Saturday', async t => {
  const { app, employee, record, request, snapshot } = await fixture(t, '2026-11-10');
  const staff = await employee();
  const result = app.locals.db.prepare(`INSERT INTO requests(employee_id,start_date,end_date,type,days,reason,status,created_at,day_policy)
    VALUES(?,?,?,'annual',2,'기존 대기','pending','2026-10-01T00:00:00.000Z','weekdays')`).run(staff.id, '2026-11-06', '2026-11-09');
  const weekend = await record(staff.id, '2026-11-07');
  assert.equal(weekend.status, 201, JSON.stringify(weekend.body));
  assert.equal(weekend.body.includesWeekends, true);
  const approved = await request('PATCH', `/api/requests/${result.lastInsertRowid}`, { status: 'approved' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.includesWeekends, false);
  assert.equal(approved.body.days, 2);
  const data = await snapshot();
  assert.equal(data.employees[0].usedDays, 3);
  assert.equal(data.employees[0].pendingDays, 0);
});

test('calendar day counting includes weekends, leap days, and calendar-year boundaries', () => {
  assert.equal(calendarDays('2026-11-06', '2026-11-09'), 4);
  assert.equal(calendarDays('2026-11-07', '2026-11-08'), 2);
  assert.equal(calendarDays('2026-12-31', '2027-01-04'), 5);
  assert.equal(calendarDays('2024-02-28', '2024-03-01'), 3);
  assert.throws(() => calendarDays('2026-02-30', '2026-03-01'));
  assert.throws(() => calendarDays('2026-11-09', '2026-11-06'));
});
