import type { EmployeeSearchRecord } from './employeeSearch.ts';

export type DirectoryView = 'list' | 'cards';
export type DirectorySort = 'name-asc' | 'name-desc' | 'join-asc' | 'join-desc';
export type DirectoryPreferences = { view: DirectoryView; sort: DirectorySort };

export const directoryPreferencesKey = 'onhyu.employeeDirectory.preferences';
export const defaultDirectoryPreferences: DirectoryPreferences = { view: 'list', sort: 'name-asc' };

export function parseDirectoryPreferences(value: unknown): DirectoryPreferences {
  if (!value || typeof value !== 'object') return { ...defaultDirectoryPreferences };
  const { view, sort } = value as Record<string, unknown>;
  return {
    view: view === 'list' || view === 'cards' ? view : defaultDirectoryPreferences.view,
    sort: sort === 'name-asc' || sort === 'name-desc' || sort === 'join-asc' || sort === 'join-desc'
      ? sort : defaultDirectoryPreferences.sort,
  };
}

const collator = new Intl.Collator('ko', { sensitivity: 'base', numeric: true });
const compareText = (left: string, right: string) => collator.compare(left.normalize('NFC'), right.normalize('NFC'));

export function sortDirectoryEmployees<T extends EmployeeSearchRecord>(employees: readonly T[], sort: DirectorySort): T[] {
  return [...employees].sort((left, right) => {
    const name = compareText(left.name, right.name);
    const date = left.joinDate.localeCompare(right.joinDate);
    const primary = sort === 'name-desc' ? -name
      : sort === 'join-asc' ? date
        : sort === 'join-desc' ? -date : name;
    return primary || name || compareText(left.department, right.department)
      || compareText(String(left.id), String(right.id));
  });
}
