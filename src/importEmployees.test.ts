import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeEmployeeFile, parseEmployeeText, templateCSV } from './importEmployees.ts';

test('CSV preserves quoted commas, escaped quotes and multiline cells with BOM and CRLF', () => {
  const rows = parseEmployeeText('\uFEFF이름,부서,직책,입사일\r\n"김,직원",개발팀,"선임 ""대리""",2020-01-02\r\n"이\r\n직원",운영팀,,2021-03-04\r\n박직원,인사팀,팀장,2022-05-06\r\n');
  assert.deepEqual(rows[0], {
    employee: { name: '김,직원', department: '개발팀', position: '선임 "대리"', joinDate: '2020-01-02' },
    sourceRow: 2,
  });
  assert.equal(rows[1].employee.name, '이\n직원');
  assert.equal(rows[1].sourceRow, 3);
  assert.equal(rows[2].sourceRow, 5);
});

test('Excel TSV supports quoted tabs, escaped quotes and multiline cells', () => {
  const rows = parseEmployeeText('성명\t부서명\t직위\t입사일자\r\n"김\t직원"\t개발팀\t"선임 ""대리"""\t2020/1/2\r\n이직원\t"고객\r\n지원"\t\t2021.3.4');
  assert.equal(rows[0].employee.name, '김\t직원');
  assert.equal(rows[0].employee.position, '선임 "대리"');
  assert.equal(rows[1].employee.department, '고객\n지원');
  assert.equal(rows[1].sourceRow, 3);
  const csv = parseEmployeeText('이름,입사일,비고\n김직원,2020-01-02,"CSV 안의\t탭"');
  assert.equal(csv[0].employee.name, '김직원');
});

test('Korean and English header aliases can be reordered while unknown columns are ignored', () => {
  const rows = parseEmployeeText('입사일자,직위,성명,비고,부서명\n2020/1/2,대리,김직원,기존 직원,개발팀');
  assert.deepEqual(rows[0].employee, { name: '김직원', department: '개발팀', position: '대리', joinDate: '2020/1/2' });
  assert.deepEqual(parseEmployeeText(' JOIN_DATE , NAME , POSITION , DEPARTMENT \n2020-01-02,김직원,선임,개발팀')[0].employee,
    { name: '김직원', department: '개발팀', position: '선임', joinDate: '2020-01-02' });
  assert.equal(parseEmployeeText('constructor,2020-01-02')[0].employee.name, 'constructor');
});

test('headerless selections accept the documented two, three and four column orders', () => {
  assert.deepEqual(parseEmployeeText(' 김직원 \t 2020-01-02 ')[0].employee,
    { name: '김직원', department: '', position: '', joinDate: '2020-01-02' });
  assert.deepEqual(parseEmployeeText('김직원,개발팀,2020-01-02')[0].employee,
    { name: '김직원', department: '개발팀', position: '', joinDate: '2020-01-02' });
  assert.deepEqual(parseEmployeeText('김직원,개발팀,대리,2020-01-02')[0].employee,
    { name: '김직원', department: '개발팀', position: '대리', joinDate: '2020-01-02' });
});

test('blank records are ignored and physical row numbers survive CR, CRLF and leading tab-only rows', () => {
  const rows = parseEmployeeText('\t \t\r\n\r\n이름,입사일\r김직원,2020-01-02\r\n,\r\n이직원,2021-03-04');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sourceRow, 4);
  assert.equal(rows[1].sourceRow, 6);
  assert.throws(() => parseEmployeeText('\r\n\t \t\r\n'), /직원 목록/);
});

test('invalid or incomplete headers and mismatched column counts produce actionable errors', () => {
  assert.throws(() => parseEmployeeText('이름,부서\n김직원,개발팀'), /첫 행 제목.*입사일/);
  assert.throws(() => parseEmployeeText('이름,입사일,성명\n김직원,2020-01-02,김직원'), /같은 항목이 두 번/);
  assert.throws(() => parseEmployeeText('김직원,2020-01-02\n이직원,개발팀,2021-03-04'), /2행: 열 개수/);
  assert.throws(() => parseEmployeeText('이름,입사일\n김직원,2020-01-02,추가값'), /2행: 제목보다 많은 열/);
  assert.throws(() => parseEmployeeText('김직원'), /2열.*3열.*4열/);
});

test('malformed quotes are rejected without silently changing employee data', () => {
  assert.throws(() => parseEmployeeText('이름,입사일\n"김직원,2020-01-02'), /2행: 큰따옴표가 닫히지/);
  assert.throws(() => parseEmployeeText('이름,입사일\n김"직원,2020-01-02'), /2행: 따옴표가 있는 셀/);
  assert.throws(() => parseEmployeeText('이름,입사일\n"김직원"추가,2020-01-02'), /2행: 닫는 따옴표 뒤/);
  assert.equal(parseEmployeeText('이름,입사일\n "김직원" ,2020-01-02')[0].employee.name, '김직원');
});

test('500 employees are accepted and 501 employees or UTF-8 text above 2MiB are rejected', () => {
  const employees = Array.from({ length: 500 }, (_, index) => `직원${index + 1},2020-01-02`);
  const rows = parseEmployeeText(`이름,입사일\n${employees.join('\n')}`);
  assert.equal(rows.length, 500);
  assert.equal(rows[499].sourceRow, 501);
  assert.throws(() => parseEmployeeText(`${employees.join('\n')}\n직원501,2020-01-02`), /최대 500명/);
  assert.throws(() => parseEmployeeText('가'.repeat(700_000)), /2MB 이하/);
});

test('file decoding handles UTF-8 BOM and Korean Excel EUC-KR, and rejects invalid or oversized files', () => {
  const unicode = new TextEncoder().encode('\uFEFF이름,입사일\r\n김직원,2020-01-02');
  assert.equal(parseEmployeeText(decodeEmployeeFile(unicode.buffer))[0].employee.name, '김직원');
  const legacy = Uint8Array.from([0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0xc0, 0xd4, 0xbb, 0xe7, 0xc0, 0xcf]);
  assert.equal(decodeEmployeeFile(legacy.buffer), '이름,입사일');
  assert.throws(() => decodeEmployeeFile(Uint8Array.from([0xff]).buffer), /인코딩/);
  assert.throws(() => decodeEmployeeFile(new ArrayBuffer(2 * 1024 * 1024 + 1)), /2MB 이하/);
});

test('downloadable template contains only the BOM-prefixed header and never registers sample staff', () => {
  assert.equal(templateCSV, '\uFEFF이름,부서,직책,입사일\r\n');
  assert.throws(() => parseEmployeeText(templateCSV), /제목 아래에 등록할 직원/);
});
