export type EmployeeSearchRecord = {
  id: number | string;
  name: string;
  department: string;
  joinDate: string;
};

const koreanCollator = new Intl.Collator('ko', { sensitivity: 'base', numeric: true });
const initials = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

export function normalizeEmployeeSearch(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('ko').replace(/\s+/gu, '');
}

function initialConsonants(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0) - 0xac00;
    return code >= 0 && code < 11172 ? initials[Math.floor(code / 588)] : character;
  }).join('');
}

export function sortEmployeesByName<T extends EmployeeSearchRecord>(employees: readonly T[]): T[] {
  return [...employees].sort((left, right) =>
    koreanCollator.compare(left.name.normalize('NFC'), right.name.normalize('NFC'))
      || koreanCollator.compare(left.department, right.department)
      || left.joinDate.localeCompare(right.joinDate)
      || koreanCollator.compare(String(left.id), String(right.id)),
  );
}

export function searchEmployees<T extends EmployeeSearchRecord>(employees: readonly T[], query: string): T[] {
  const normalizedQuery = normalizeEmployeeSearch(query);
  const sorted = sortEmployeesByName(employees);
  if (!normalizedQuery) return sorted;
  const initialQuery = /^[ㄱ-ㅎ]+$/u.test(normalizedQuery);
  return sorted.map((employee) => {
    const name = normalizeEmployeeSearch(employee.name);
    const department = normalizeEmployeeSearch(employee.department);
    let rank = -1;
    if (name === normalizedQuery) rank = 0;
    else if (name.startsWith(normalizedQuery)) rank = 1;
    else if (name.includes(normalizedQuery)) rank = 2;
    else if (initialQuery && initialConsonants(name).includes(normalizedQuery)) rank = 3;
    else if (department.includes(normalizedQuery)) rank = 4;
    return { employee, rank };
  }).filter(({ rank }) => rank !== -1)
    .sort((left, right) => left.rank - right.rank)
    .map(({ employee }) => employee);
}
