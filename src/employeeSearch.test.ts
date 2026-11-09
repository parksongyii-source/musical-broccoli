import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEmployeeSearch, searchEmployees, sortEmployeesByName } from './employeeSearch.ts';

const employees = [
  { id: 4, name: '김민수', department: '요양팀', joinDate: '2022-06-01' },
  { id: 2, name: '박영희', department: '간호팀', joinDate: '2020-01-01' },
  { id: 3, name: '김민수', department: '간호팀', joinDate: '2023-03-01' },
  { id: 5, name: '김민수연', department: '행정팀', joinDate: '2024-01-01' },
  { id: 6, name: '이김민수', department: '행정팀', joinDate: '2024-01-01' },
  { id: 7, name: 'Alice Kim', department: 'Office', joinDate: '2024-01-01' },
];

test('employee search ranks exact names before prefixes and substrings', () => {
  assert.deepEqual(searchEmployees(employees, '김민수').map(({ id }) => id), [3, 4, 5, 6]);
});

test('name matching ignores whitespace, Latin case, and decomposed Korean', () => {
  assert.deepEqual(searchEmployees(employees, ' 김 민 수 ').map(({ id }) => id), [3, 4, 5, 6]);
  assert.deepEqual(searchEmployees(employees, 'ALICEKIM').map(({ id }) => id), [7]);
  assert.deepEqual(searchEmployees(employees, '박영희'.normalize('NFD')).map(({ id }) => id), [2]);
  assert.equal(normalizeEmployeeSearch('  AlICE\t KIM '), 'alicekim');
});

test('duplicate names remain distinct and department makes them easy to find', () => {
  assert.deepEqual(searchEmployees(employees, '간호').map(({ id }) => id), [3, 2]);
  const duplicateNames = searchEmployees(employees, '김민수').filter(({ name }) => name === '김민수');
  assert.equal(duplicateNames.length, 2);
  assert.deepEqual(duplicateNames.map(({ id, department, joinDate }) => ({ id, department, joinDate })), [
    { id: 3, department: '간호팀', joinDate: '2023-03-01' },
    { id: 4, department: '요양팀', joinDate: '2022-06-01' },
  ]);
});

test('Korean initial consonants find staff without automatically choosing one', () => {
  assert.deepEqual(searchEmployees(employees, 'ㅂㅇㅎ').map(({ id }) => id), [2]);
  assert.equal(searchEmployees(employees, '없는직원').length, 0);
});

test('empty queries return a sorted copy with department and date tie breaks', () => {
  const input = [
    { id: 'later', name: '김민수', department: '간호팀', joinDate: '2023-01-01' },
    { id: 'earlier', name: '김민수', department: '간호팀', joinDate: '2022-01-01' },
    employees[1],
  ];
  const originalIds = input.map(({ id }) => id);
  assert.deepEqual(sortEmployeesByName(input).map(({ id }) => id), ['earlier', 'later', 2]);
  assert.deepEqual(searchEmployees(input, '  ').map(({ id }) => id), ['earlier', 'later', 2]);
  assert.deepEqual(input.map(({ id }) => id), originalIds);
});
