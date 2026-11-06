import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from './index.js';

const AS_OF = '2026-11-06';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'onhyu-bulk-test-'));
  const app = createApp({ dbPath: join(directory, 'leave.sqlite'), seed: false, today: () => AS_OF });
  const server = createServer(app);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    app.locals.close();
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, path, body) {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const preview = employees => request('POST', '/api/employees/import-preview', { employees, asOf: AS_OF });
  const bulk = employees => request('POST', '/api/employees/bulk', { employees, asOf: AS_OF });
  async function snapshot() {
    const response = await request('GET', `/api/bootstrap?asOf=${AS_OF}`);
    assert.equal(response.status, 200);
    return response.body;
  }
  return { app, request, preview, bulk, snapshot };
}

function staff(index, overrides = {}) {
  return {
    name: `일괄직원 ${String(index).padStart(3, '0')}`,
    department: '운영팀',
    position: '매니저',
    joinDate: '2023-07-12',
    ...overrides,
  };
}

test('44-person preview writes nothing and one batch registers everyone with automatic leave', async t => {
  const { app, preview, bulk, snapshot } = await fixture(t);
  const employees = Array.from({ length: 44 }, (_, index) => staff(index));
  const checked = await preview(employees);
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.deepEqual(checked.body.summary, { total: 44, ready: 44, duplicate: 0, invalid: 0 });
  assert.equal(checked.body.canImport, true);
  assert.equal(checked.body.rows.length, 44);
  for (const [index, row] of checked.body.rows.entries()) {
    assert.equal(row.rowNumber, index + 1);
    assert.equal(row.status, 'ready');
    assert.deepEqual(row.errors, []);
    assert.equal(row.automaticAllowance, 16);
    assert.equal(row.periodStart, '2026-07-12');
    assert.equal(row.periodEnd, '2027-07-11');
  }
  assert.deepEqual((await snapshot()).employees, []);
  const result = await bulk(employees);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.imported, 44);
  assert.equal(result.body.employees.length, 44);
  assert.equal(new Set(result.body.employees.map(employee => employee.id)).size, 44);
  for (const employee of result.body.employees) {
    assert.equal(employee.allowanceMode, 'auto');
    assert.equal(employee.annualAllowance, 16);
    assert.equal(employee.remainingDays, 16);
  }
  assert.equal((await snapshot()).employees.length, 44);
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM allowances').get().count, 0);
});

test('one invalid date in the middle blocks the entire batch without registering earlier valid rows', async t => {
  const { preview, bulk, snapshot } = await fixture(t);
  const employees = Array.from({ length: 44 }, (_, index) => staff(index));
  employees[21].joinDate = '2026-02-30';
  const checked = await preview(employees);
  assert.equal(checked.status, 200);
  assert.equal(checked.body.canImport, false);
  assert.equal(checked.body.summary.ready, 43);
  assert.equal(checked.body.summary.invalid, 1);
  assert.equal(checked.body.rows[21].status, 'invalid');
  assert.ok(checked.body.rows[21].errors.length > 0);
  const result = await bulk(employees);
  assert.equal(result.status, 422);
  assert.equal(typeof result.body.error, 'string');
  assert.equal(result.body.summary.invalid, 1);
  assert.deepEqual((await snapshot()).employees, []);
});

test('later duplicate input is identified after trimming and canonical date normalization', async t => {
  const { preview, bulk, snapshot } = await fixture(t);
  const employees = [staff(1), staff(2, { name: ' 일괄직원 001 ', department: ' 운영팀 ', joinDate: '2023.7.12' }), staff(3)];
  const checked = await preview(employees);
  assert.equal(checked.status, 200);
  assert.deepEqual(checked.body.summary, { total: 3, ready: 2, duplicate: 1, invalid: 0 });
  assert.deepEqual(checked.body.rows.map(row => row.status), ['ready', 'duplicate', 'ready']);
  assert.equal(checked.body.canImport, false);
  assert.equal((await bulk(employees)).status, 422);
  assert.deepEqual((await snapshot()).employees, []);
});

test('replaying a batch or submitting a mixed existing/new list cannot create duplicate staff', async t => {
  const { preview, bulk, snapshot } = await fixture(t);
  assert.equal((await bulk([staff(1)])).status, 201);
  const checked = await preview([staff(1), staff(2)]);
  assert.deepEqual(checked.body.summary, { total: 2, ready: 1, duplicate: 1, invalid: 0 });
  assert.equal(checked.body.rows[0].status, 'duplicate');
  assert.equal((await bulk([staff(1), staff(2)])).status, 422);
  assert.equal((await bulk([staff(1)])).status, 422);
  const employees = (await snapshot()).employees;
  assert.equal(employees.length, 1);
  assert.equal(employees[0].name, staff(1).name);
});

test('commit revalidates against the current database rather than trusting an earlier successful preview', async t => {
  const { request, preview, bulk, snapshot } = await fixture(t);
  const employees = [staff(1), staff(2)];
  assert.equal((await preview(employees)).body.canImport, true);
  const independentlyCreated = await request('POST', '/api/employees', { ...staff(2), asOf: AS_OF });
  assert.equal(independentlyCreated.status, 201);
  const result = await bulk(employees);
  assert.equal(result.status, 422);
  assert.equal(result.body.summary.duplicate, 1);
  const saved = (await snapshot()).employees;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, independentlyCreated.body.id);
});

test('supported spreadsheet date formats become canonical dates and optional fields get safe defaults', async t => {
  const { preview, bulk, snapshot } = await fixture(t);
  const employees = [
    { name: ' 형식 하나 ', joinDate: '2023-7-12' },
    { name: '형식 둘', department: '', position: ' ', joinDate: '2023.7.12' },
    { name: '형식 셋', department: ' 운영팀 ', position: ' 매니저 ', joinDate: '2023/07/12' },
    { name: '형식 넷', joinDate: '20230712' },
  ];
  const checked = await preview(employees);
  assert.equal(checked.body.canImport, true, JSON.stringify(checked.body));
  assert.equal(checked.body.rows[0].employee.name, '형식 하나');
  assert.equal(checked.body.rows[0].employee.department, '미지정');
  assert.equal(checked.body.rows[0].employee.position, '');
  assert.equal(checked.body.rows[1].employee.department, '미지정');
  assert.equal(checked.body.rows[2].employee.position, '매니저');
  assert.ok(checked.body.rows.every(row => row.employee.joinDate === '2023-07-12'));
  assert.equal((await bulk(employees)).status, 201);
  assert.ok((await snapshot()).employees.every(employee => employee.joinDate === '2023-07-12'));
});

test('same name with a different joining date or department is not silently treated as the same employee', async t => {
  const { bulk, snapshot } = await fixture(t);
  const result = await bulk([
    staff(1, { name: '동명이인' }),
    staff(2, { name: '동명이인', joinDate: '2024-07-12' }),
    staff(3, { name: '동명이인', department: '개발팀' }),
  ]);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.imported, 3);
  assert.equal((await snapshot()).employees.length, 3);
});

test('malformed batches and oversized lists are rejected while malformed rows are reported with row errors', async t => {
  const { request, preview, bulk, snapshot } = await fixture(t);
  for (const employees of [undefined, null, {}, 'not a list', [], Array.from({ length: 501 }, (_, index) => staff(index))]) {
    for (const endpoint of ['/api/employees/import-preview', '/api/employees/bulk']) {
      const result = await request('POST', endpoint, { employees, asOf: AS_OF });
      assert.equal(result.status, 400, JSON.stringify(result));
      assert.equal(typeof result.body.error, 'string');
    }
  }
  const invalidRows = [
    null, 42, [],
    staff(1, { name: '' }), staff(2, { name: 123 }), staff(3, { name: '가'.repeat(41) }),
    staff(4, { department: 123 }), staff(5, { department: '가'.repeat(61) }),
    staff(6, { position: 123 }), staff(7, { position: '가'.repeat(61) }),
    staff(8, { joinDate: 20230712 }), staff(9, { joinDate: '2026-02-29' }),
    staff(10, { joinDate: '1899-01-01' }), staff(11, { joinDate: '2101-01-01' }),
  ];
  const checked = await preview(invalidRows);
  assert.equal(checked.status, 200);
  assert.equal(checked.body.summary.invalid, invalidRows.length);
  assert.ok(checked.body.rows.every(row => row.status === 'invalid' && row.errors.length > 0));
  assert.equal((await bulk(invalidRows)).status, 422);
  assert.equal((await request('POST', '/api/employees/bulk', { employees: [staff(1)], asOf: '2026-02-30' })).status, 400);
  assert.deepEqual((await snapshot()).employees, []);
});

test('a full supported 500-person batch fits the JSON limit and remains automatic', async t => {
  const { bulk, snapshot } = await fixture(t);
  const employees = Array.from({ length: 500 }, (_, index) => staff(index, {
    department: '경영지원및인사운영부서', position: '프로젝트지원담당자',
    allowanceMode: 'manual', annualAllowance: 100,
  }));
  assert.ok(Buffer.byteLength(JSON.stringify({ employees, asOf: AS_OF })) > 32768);
  const result = await bulk(employees);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.imported, 500);
  assert.equal((await snapshot()).employees.length, 500);
  assert.ok(result.body.employees.every(employee => employee.allowanceMode === 'auto' && employee.annualAllowance === 16));
});

test('a database insertion failure rolls back all earlier inserts in the batch', async t => {
  const { app, bulk, snapshot } = await fixture(t);
  app.locals.db.exec(`CREATE TRIGGER reject_bulk_fixture BEFORE INSERT ON employees
    WHEN NEW.name = '강제 실패' BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END;`);
  const result = await bulk([staff(1), staff(2, { name: '강제 실패' }), staff(3)]);
  assert.equal(result.status, 500);
  assert.deepEqual((await snapshot()).employees, []);
});
