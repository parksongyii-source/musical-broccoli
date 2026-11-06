import { calculateEntitlement } from './entitlement.js';

export const MAX_IMPORT_EMPLOYEES = 500;

/** Normalize civil dates from common Korean spreadsheet display formats. */
export function normalizeImportDate(value) {
  if (typeof value !== 'string') throw new RangeError('입사일을 날짜 형식으로 입력해 주세요.');
  const clean = value.trim();
  const match = /^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\s*\.?$/.exec(clean)
    ?? /^(\d{4})(\d{2})(\d{2})$/.exec(clean);
  if (!match) throw new RangeError('입사일은 YYYY-MM-DD 형식으로 입력해 주세요.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${normalized}T00:00:00Z`);
  if (year < 1900 || year > 2100 || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new RangeError('입사일은 1900~2100년 범위의 실제 날짜여야 합니다.');
  }
  return normalized;
}

function cleanedText(value, label, { max, required = false, fallback = '' }, errors) {
  if (value == null && !required) return fallback;
  if (typeof value !== 'string') {
    errors.push(`${label}을(를) ${required ? '입력해' : '문자로 입력해'} 주세요.`);
    return '';
  }
  const clean = value.trim().normalize('NFC');
  if (!clean) {
    if (required) errors.push(`${label}을(를) 입력해 주세요.`);
    return fallback;
  }
  if (clean.length > max) errors.push(`${label}은(는) 최대 ${max}자여야 합니다.`);
  return clean;
}

function employeeKey(employee) {
  return JSON.stringify([
    employee.name.trim().normalize('NFC'),
    employee.department.trim().normalize('NFC'),
    employee.joinDate,
  ]);
}

/** Read-only validation shared by preview and the atomic commit transaction. */
export function previewEmployeeImport(employees, existing, asOf, periodForDate) {
  const existingKeys = new Set(existing.map(employee => employeeKey({
    name: employee.name, department: employee.department, joinDate: employee.join_date,
  })));
  const seen = new Set();
  const rows = employees.map((raw, index) => {
    const errors = [];
    const object = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
    if (!object) errors.push('직원 정보는 이름·부서·직책·입사일로 입력해 주세요.');
    const input = object ? raw : {};
    const employee = {
      name: cleanedText(input.name, '이름', { max: 40, required: true }, errors),
      department: cleanedText(input.department, '부서', { max: 60, fallback: '미지정' }, errors),
      position: cleanedText(input.position, '직책', { max: 60 }, errors),
      joinDate: typeof input.joinDate === 'string' ? input.joinDate.trim() : '',
    };
    try { employee.joinDate = normalizeImportDate(input.joinDate); }
    catch (error) { errors.push(error.message); }
    const row = { rowNumber: index + 1, employee, status: 'invalid', errors, automaticAllowance: null };
    if (errors.length) return row;
    Object.assign(row, calculateEntitlement(employee.joinDate, asOf), periodForDate(employee.joinDate, asOf));
    const key = employeeKey(employee);
    if (existingKeys.has(key)) {
      row.status = 'duplicate';
      errors.push('같은 이름·부서·입사일의 직원이 이미 등록되어 있습니다.');
    } else if (seen.has(key)) {
      row.status = 'duplicate';
      errors.push('이 목록의 앞선 행에 같은 이름·부서·입사일이 있습니다.');
    } else {
      row.status = 'ready';
      seen.add(key);
    }
    return row;
  });
  const summary = { total: rows.length, ready: 0, duplicate: 0, invalid: 0 };
  for (const row of rows) summary[row.status] += 1;
  return { rows, summary, canImport: summary.ready > 0 && summary.invalid === 0 && summary.duplicate === 0 };
}
