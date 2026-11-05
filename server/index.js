import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = new Set(['annual', 'half_am', 'half_pm']);
const ACTIVE = new Set(['pending', 'approved']);

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function fail(message, status = 400) { throw new ApiError(status, message); }
function has(object, name) { return Object.prototype.hasOwnProperty.call(object, name); }
function text(value, name, { required = true, max = 100 } = {}) {
  if (typeof value !== 'string') {
    if (!required && value == null) return '';
    fail(`${name}을(를) 입력해 주세요.`);
  }
  const clean = value.trim();
  if ((required && !clean) || clean.length > max) fail(`${name}은(는) ${required ? '1~' : '최대 '}${max}자여야 합니다.`);
  return clean;
}

export function seoulYear() {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric' }).format(new Date()));
}

export function seoulToday() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function validYear(value = seoulYear()) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) fail('연도는 2000~2100 범위로 입력해 주세요.');
  return year;
}

function dateValue(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} 형식이 올바르지 않습니다.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(`${label}이(가) 올바른 날짜가 아닙니다.`);
  validYear(date.getUTCFullYear());
  return date;
}

function anniversary(joinDate, year) {
  const month = Number(joinDate.slice(5, 7));
  const day = Number(joinDate.slice(8, 10));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(day, lastDay)));
}

function cycleAtYear(joinDate, year, active = true) {
  const start = anniversary(joinDate, year);
  const end = anniversary(joinDate, year + 1);
  end.setUTCDate(end.getUTCDate() - 1);
  return { periodStart: start.toISOString().slice(0, 10), periodEnd: end.toISOString().slice(0, 10), allowanceYear: year, active };
}

export function employmentPeriod(joinDate, asOf = seoulToday()) {
  dateValue(joinDate, '입사일');
  const at = dateValue(asOf, '조회 기준일');
  const joinYear = Number(joinDate.slice(0, 4));
  if (asOf < joinDate) return cycleAtYear(joinDate, joinYear, false);
  let year = at.getUTCFullYear();
  if (anniversary(joinDate, year) > at) year -= 1;
  return cycleAtYear(joinDate, year);
}

export function businessDays(startDate, endDate) {
  const start = dateValue(startDate, '시작일');
  const end = dateValue(endDate, '종료일');
  if (end < start) fail('종료일은 시작일보다 빠를 수 없습니다.');
  let count = 0;
  for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) count += 1;
  }
  return count;
}

function requestDays(start, end, type) {
  const days = businessDays(start, end);
  if (!days) fail('주말만 포함된 휴가는 신청할 수 없습니다.');
  if (type !== 'annual') {
    if (start !== end) fail('반차는 평일 하루만 선택해 주세요.');
    return 0.5;
  }
  return days;
}

function positiveId(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))) fail('잘못된 식별자입니다.');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail('잘못된 식별자입니다.');
  return id;
}

function allowanceValue(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 365 || value * 2 !== Math.floor(value * 2)) {
    fail('연차 부여 일수는 0~365일 범위에서 0.5일 단위로 입력해 주세요.');
  }
  return value;
}

export function createApp({ dbPath = process.env.DB_PATH || join(ROOT, 'data', 'leave.sqlite'), seed = process.env.SEED_DEMO !== '0', staticDir = join(ROOT, 'dist'), configureApp } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      department TEXT NOT NULL,
      position TEXT NOT NULL DEFAULT '',
      join_date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS allowances (
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      year INTEGER NOT NULL,
      days REAL NOT NULL CHECK(days >= 0),
      PRIMARY KEY(employee_id, year)
    );
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('annual','half_am','half_pm')),
      days REAL NOT NULL CHECK(days > 0),
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
      created_at TEXT NOT NULL,
      review_note TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS requests_employee_date ON requests(employee_id, start_date, end_date);
  `);

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function employeeExists(id) {
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    if (!employee) fail('직원을 찾을 수 없습니다.', 404);
    return employee;
  }
  function allowance(id, period) {
    if (!period.active) return 0;
    return db.prepare('SELECT days FROM allowances WHERE employee_id = ? AND year = ?').get(id, period.allowanceYear)?.days ?? 0;
  }
  function totals(id, period, excludeId = 0) {
    if (!period.active) return { used: 0, pending: 0 };
    const result = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'approved' THEN days ELSE 0 END), 0) AS used,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN days ELSE 0 END), 0) AS pending
      FROM requests WHERE employee_id = ? AND start_date >= ? AND start_date <= ? AND id != ?`).get(id, period.periodStart, period.periodEnd, excludeId);
    return { used: Number(result.used), pending: Number(result.pending) };
  }
  function employeeView(raw, asOf) {
    const period = employmentPeriod(raw.join_date, asOf);
    const configuredAllowance = db.prepare('SELECT days FROM allowances WHERE employee_id = ? AND year = ?').get(raw.id, period.allowanceYear)?.days ?? 0;
    const assigned = allowance(raw.id, period);
    const balance = totals(raw.id, period);
    return {
      id: raw.id, name: raw.name, department: raw.department, position: raw.position,
      joinDate: raw.join_date, annualAllowance: assigned, usedDays: balance.used,
      pendingDays: balance.pending, remainingDays: assigned - balance.used,
      periodStart: period.periodStart, periodEnd: period.periodEnd, allowanceYear: period.allowanceYear,
      configuredAllowance,
    };
  }
  function requestView(raw) {
    const employee = employeeExists(raw.employee_id);
    return {
      id: raw.id, employeeId: raw.employee_id, employeeName: employee.name, department: employee.department,
      startDate: raw.start_date, endDate: raw.end_date, type: raw.type, days: raw.days,
      reason: raw.reason, status: raw.status, createdAt: raw.created_at, reviewNote: raw.review_note,
    };
  }
  function findRequest(id) {
    const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    if (!request) fail('휴가 신청을 찾을 수 없습니다.', 404);
    return request;
  }
  function ensureBalance(id, period, days, excludeId = 0) {
    const { used, pending } = totals(id, period, excludeId);
    if (used + pending + days > allowance(id, period)) fail('해당 입사일 기준 기간의 신청 가능한 잔여 연차가 부족합니다. 승인 대기 중인 휴가도 포함됩니다.', 409);
  }
  function ensureNoOverlap(id, start, end, type, excludeId = 0) {
    const others = db.prepare(`SELECT * FROM requests WHERE employee_id = ? AND status IN ('pending','approved')
      AND start_date <= ? AND end_date >= ? AND id != ?`).all(id, end, start, excludeId);
    for (const other of others) {
      if (type !== 'annual' && other.type !== 'annual' && type !== other.type && start === other.start_date) continue;
      const overlapStart = start > other.start_date ? start : other.start_date;
      const overlapEnd = end < other.end_date ? end : other.end_date;
      if (businessDays(overlapStart, overlapEnd) > 0) fail('같은 날짜에 승인되었거나 대기 중인 휴가가 있습니다.', 409);
    }
  }

  if (seed && db.prepare('SELECT COUNT(*) AS count FROM employees').get().count === 0) {
    transaction(() => {
      const year = seoulYear();
      const staff = [
        ['김서연', '경영지원팀', '팀장', '2020-03-02', 20],
        ['이준호', '개발팀', '선임', '2021-07-12', 18],
        ['박지민', '디자인팀', '매니저', '2022-02-14', 17],
        ['최유진', '마케팅팀', '매니저', '2023-06-01', 16],
        ['정도윤', '개발팀', '매니저', '2024-01-08', 15],
        ['한수빈', '경영지원팀', '매니저', '2024-09-02', 15],
        ['윤하늘', '디자인팀', '매니저', '2025-03-10', 15],
        ['송민재', '마케팅팀', '매니저', '2025-08-04', 15],
      ];
      const insertEmployee = db.prepare('INSERT INTO employees(name,department,position,join_date) VALUES(?,?,?,?)');
      const insertAllowance = db.prepare('INSERT INTO allowances(employee_id,year,days) VALUES(?,?,?)');
      for (const [name, department, position, date, days] of staff) {
        const result = insertEmployee.run(name, department, position, date);
        insertAllowance.run(Number(result.lastInsertRowid), employmentPeriod(date).allowanceYear, days);
      }
      const insertRequest = db.prepare(`INSERT INTO requests(employee_id,start_date,end_date,type,days,reason,status,created_at,review_note)
        VALUES(?,?,?,?,?,?,?,?,?)`);
      const month = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', month: '2-digit' }).format(new Date());
      const weekday = (day) => {
        const value = new Date(Date.UTC(year, Number(month) - 1, day));
        while (value.getUTCDay() === 0 || value.getUTCDay() === 6) value.setUTCDate(value.getUTCDate() + 1);
        return value.toISOString().slice(0, 10);
      };
      const createdAt = new Date().toISOString();
      const sample = [
        [1, `${year}-03-09`, `${year}-03-10`, 'annual', '개인 일정', 'approved'],
        [2, weekday(3), weekday(3), 'annual', '가족 행사', 'approved'],
        [3, weekday(12), weekday(13), 'annual', '재충전 휴가', 'pending'],
        [4, weekday(18), weekday(18), 'half_pm', '개인 용무', 'pending'],
        [5, weekday(23), weekday(24), 'annual', '가족 여행', 'pending'],
        [6, `${year}-07-06`, `${year}-07-08`, 'annual', '여름 휴가', 'approved'],
        [7, weekday(9), weekday(9), 'half_am', '개인 일정', 'approved'],
        [8, weekday(26), weekday(26), 'annual', '개인 일정', 'pending'],
      ];
      for (const [id, start, end, type, reason, status] of sample) {
        const [, , , joinDate, assigned] = staff[id - 1];
        const period = employmentPeriod(joinDate, start);
        if (!period.active || end > period.periodEnd) continue;
        db.prepare('INSERT OR IGNORE INTO allowances(employee_id,year,days) VALUES(?,?,?)').run(id, period.allowanceYear, assigned);
        const days = type === 'annual' ? businessDays(start, end) : 0.5;
        if (days) insertRequest.run(id, start, end, type, days, reason, status, createdAt, '');
      }
    });
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.locals.db = db;
  app.locals.close = () => db.close();
  if (configureApp) configureApp(app);

  app.get('/api/desktop-info', (_req, res) => res.json({ standalone: false }));

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/bootstrap', (req, res) => {
    const asOf = req.query.asOf ?? (req.query.year === undefined ? seoulToday() : `${validYear(req.query.year)}-12-31`);
    dateValue(asOf, '조회 기준일');
    const year = Number(asOf.slice(0, 4));
    const employees = db.prepare('SELECT * FROM employees ORDER BY id').all().map((raw) => employeeView(raw, asOf));
    const periods = new Map(employees.map((employee) => [employee.id, employee]));
    const requests = db.prepare('SELECT * FROM requests ORDER BY created_at DESC,id DESC').all().filter((raw) => {
      const period = periods.get(raw.employee_id);
      return asOf >= period.joinDate && raw.start_date >= period.periodStart && raw.start_date <= period.periodEnd;
    }).map(requestView);
    res.json({ year, asOf, employees, requests });
  });

  app.post('/api/employees', (req, res) => {
    const body = req.body ?? {};
    const name = text(body.name, '이름', { max: 40 });
    const department = text(body.department, '부서', { max: 60 });
    const position = text(body.position, '직책', { required: false, max: 60 });
    dateValue(body.joinDate, '입사일');
    const asOf = body.asOf ?? seoulToday();
    const selectedPeriod = employmentPeriod(body.joinDate, asOf);
    const year = validYear(body.allowanceYear ?? body.year ?? selectedPeriod.allowanceYear);
    if (year < Number(body.joinDate.slice(0, 4))) fail('입사 이전 기간에는 연차를 부여할 수 없습니다.');
    const assigned = allowanceValue(body.annualAllowance ?? 15);
    const employee = transaction(() => {
      const result = db.prepare('INSERT INTO employees(name,department,position,join_date) VALUES(?,?,?,?)').run(name, department, position, body.joinDate);
      const id = Number(result.lastInsertRowid);
      db.prepare('INSERT INTO allowances(employee_id,year,days) VALUES(?,?,?)').run(id, year, assigned);
      return employeeView(employeeExists(id), body.asOf ?? cycleAtYear(body.joinDate, year).periodStart);
    });
    res.status(201).json(employee);
  });

  app.patch('/api/employees/:id', (req, res) => {
    const id = positiveId(req.params.id);
    const previous = employeeExists(id);
    const body = req.body ?? {};
    const name = has(body, 'name') ? text(body.name, '이름', { max: 40 }) : previous.name;
    const department = has(body, 'department') ? text(body.department, '부서', { max: 60 }) : previous.department;
    const position = has(body, 'position') ? text(body.position, '직책', { required: false, max: 60 }) : previous.position;
    const joinDate = has(body, 'joinDate') ? body.joinDate : previous.join_date;
    dateValue(joinDate, '입사일');
    const asOf = body.asOf ?? seoulToday();
    const selectedPeriod = employmentPeriod(joinDate, asOf);
    const year = validYear(joinDate !== previous.join_date ? selectedPeriod.allowanceYear : (body.allowanceYear ?? body.year ?? selectedPeriod.allowanceYear));
    if (year < Number(joinDate.slice(0, 4))) fail('입사 이전 기간에는 연차를 부여할 수 없습니다.');
    const period = cycleAtYear(joinDate, year);
    const assigned = has(body, 'annualAllowance') ? allowanceValue(body.annualAllowance) : allowance(id, period);
    const employee = transaction(() => {
      const { used, pending } = totals(id, period);
      if (assigned < used + pending) fail('부여 연차는 사용한 연차와 승인 대기 일수의 합계보다 작을 수 없습니다.', 409);
      const earliest = db.prepare("SELECT MIN(start_date) AS firstDate FROM requests WHERE employee_id = ? AND status IN ('pending','approved')").get(id).firstDate;
      if (earliest && joinDate !== previous.join_date) fail('승인 또는 대기 중인 휴가가 있는 직원의 입사일은 변경할 수 없습니다. 기존 휴가를 먼저 정리해 주세요.', 409);
      db.prepare('UPDATE employees SET name=?,department=?,position=?,join_date=? WHERE id=?').run(name, department, position, joinDate, id);
      db.prepare(`INSERT INTO allowances(employee_id,year,days) VALUES(?,?,?)
        ON CONFLICT(employee_id,year) DO UPDATE SET days=excluded.days`).run(id, year, assigned);
      return employeeView(employeeExists(id), body.asOf ?? period.periodStart);
    });
    res.json(employee);
  });

  app.post('/api/requests', (req, res) => {
    const body = req.body ?? {};
    const id = positiveId(body.employeeId);
    const employee = employeeExists(id);
    if (!TYPES.has(body.type)) fail('연차 또는 오전·오후 반차를 선택해 주세요.');
    const reason = text(body.reason, '사유', { required: false, max: 500 });
    const days = requestDays(body.startDate, body.endDate, body.type);
    if (body.startDate < employee.join_date) fail('입사일 이전의 휴가는 신청할 수 없습니다.');
    const period = employmentPeriod(employee.join_date, body.startDate);
    if (body.endDate > period.periodEnd) fail('입사일 기준 연차 기간이 바뀌는 날짜를 걸쳐 신청할 수 없습니다. 기간별로 나누어 신청해 주세요.');
    const request = transaction(() => {
      ensureBalance(id, period, days);
      ensureNoOverlap(id, body.startDate, body.endDate, body.type);
      const result = db.prepare(`INSERT INTO requests(employee_id,start_date,end_date,type,days,reason,status,created_at)
        VALUES(?,?,?,?,?,?,'pending',?)`).run(id, body.startDate, body.endDate, body.type, days, reason, new Date().toISOString());
      return requestView(findRequest(Number(result.lastInsertRowid)));
    });
    res.status(201).json(request);
  });

  app.patch('/api/requests/:id', (req, res) => {
    const id = positiveId(req.params.id);
    const body = req.body ?? {};
    if (!['approved', 'rejected', 'cancelled'].includes(body.status)) fail('올바른 처리 상태를 선택해 주세요.');
    const note = text(body.reviewNote, '검토 메모', { required: false, max: 500 });
    const request = transaction(() => {
      const previous = findRequest(id);
      if (body.status === 'cancelled') {
        if (!ACTIVE.has(previous.status)) fail('대기 또는 승인 상태의 휴가만 취소할 수 있습니다.', 409);
      } else if (previous.status !== 'pending') fail('대기 중인 휴가만 승인하거나 반려할 수 있습니다.', 409);
      if (body.status === 'approved') {
        const employee = employeeExists(previous.employee_id);
        const period = employmentPeriod(employee.join_date, previous.start_date);
        if (!period.active || previous.end_date > period.periodEnd) fail('이 휴가는 입사일 기준 기간을 벗어납니다. 취소 후 기간별로 다시 신청해 주세요.', 409);
        ensureBalance(previous.employee_id, period, previous.days, id);
        ensureNoOverlap(previous.employee_id, previous.start_date, previous.end_date, previous.type, id);
      }
      db.prepare('UPDATE requests SET status=?,review_note=? WHERE id=?').run(body.status, note, id);
      return requestView(findRequest(id));
    });
    res.json(request);
  });

  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'API 경로를 찾을 수 없습니다.')));
  const dist = resolve(staticDir);
  if (existsSync(join(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get('/{*path}', (_req, res) => res.sendFile(join(dist, 'index.html')));
  }
  app.use((error, _req, res, _next) => {
    if (error instanceof ApiError) return res.status(error.status).json({ error: error.message });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON 요청 형식이 올바르지 않습니다.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: '요청 데이터가 너무 큽니다.' });
    console.error('API error:', error.message);
    res.status(500).json({ error: '요청을 처리하지 못했습니다. 다시 시도해 주세요.' });
  });
  return app;
}

if (typeof ONHYU_BUNDLED === 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createApp();
  const port = Number(process.env.PORT || 3001);
  const host = process.env.HOST || '127.0.0.1';
  const server = app.listen(port, host, () => console.log(`연차 관리 서버 실행: ${host}:${port}`));
  const shutdown = () => server.close(() => { app.locals.close(); process.exit(0); });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
