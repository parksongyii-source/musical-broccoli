import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDirectoryPreferences, sortDirectoryEmployees } from './employeeDirectoryModel.ts';

const employees = [
  { id: 4, name: '박다정', department: '요양팀', joinDate: '2024-02-01' },
  { id: 12, name: '김하늘', department: '요양팀', joinDate: '2022-06-01' },
  { id: 2, name: '김하늘', department: '간호팀', joinDate: '2024-02-01' },
  { id: 3, name: '이새봄', department: '행정팀', joinDate: '2020-01-01' },
  { id: 1, name: '김하늘', department: '요양팀', joinDate: '2022-06-01' },
];

test('name sorting supports both directions while keeping duplicate-name ties predictable', () => {
  assert.deepEqual(sortDirectoryEmployees(employees, 'name-asc').map(({ id }) => id), [2, 1, 12, 4, 3]);
  assert.deepEqual(sortDirectoryEmployees(employees, 'name-desc').map(({ id }) => id), [3, 4, 2, 1, 12]);
});

test('hire-date sorting supports oldest and newest with Korean name, team, and numeric-ID ties', () => {
  assert.deepEqual(sortDirectoryEmployees(employees, 'join-asc').map(({ id }) => id), [3, 1, 12, 2, 4]);
  assert.deepEqual(sortDirectoryEmployees(employees, 'join-desc').map(({ id }) => id), [2, 4, 1, 12, 3]);
});

test('sorting preserves all employee records and never mutates its input', () => {
  const frozen = Object.freeze(employees.map((employee) => Object.freeze({ ...employee, position: '담당' })));
  for (const sort of ['name-asc', 'name-desc', 'join-asc', 'join-desc'] as const) {
    const sorted = sortDirectoryEmployees(frozen, sort);
    assert.notEqual(sorted, frozen);
    assert.equal(sorted.length, frozen.length);
    for (const employee of sorted) assert.equal(employee, frozen.find(({ id }) => id === employee.id));
  }
  assert.deepEqual(frozen.map(({ id }) => id), [4, 12, 2, 3, 1]);
});

test('stored preferences accept only known views and sorting options, with independent defaults', () => {
  assert.deepEqual(parseDirectoryPreferences({ view: 'cards', sort: 'join-desc' }), { view: 'cards', sort: 'join-desc' });
  assert.deepEqual(parseDirectoryPreferences({ view: 'broken', sort: 'join-asc' }), { view: 'list', sort: 'join-asc' });
  assert.deepEqual(parseDirectoryPreferences({ view: 'cards', sort: 'arbitrary' }), { view: 'cards', sort: 'name-asc' });
  for (const value of [null, undefined, 7, 'cards', [], { view: true, sort: null }]) {
    assert.deepEqual(parseDirectoryPreferences(value), { view: 'list', sort: 'name-asc' });
  }
});

test('Korean names compare consistently across Unicode normalization forms', () => {
  const equivalentNames = [
    { id: 2, name: '김하늘'.normalize('NFD'), department: '요양팀', joinDate: '2020-01-01' },
    { id: 1, name: '김하늘', department: '요양팀', joinDate: '2020-01-01' },
  ];
  assert.deepEqual(sortDirectoryEmployees(equivalentNames, 'name-asc').map(({ id }) => id), [1, 2]);
});
