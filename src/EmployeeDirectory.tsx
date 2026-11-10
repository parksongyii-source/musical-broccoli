import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, LayoutGrid, List, Pencil, Search, UsersRound, X } from 'lucide-react';
import { searchEmployees } from './employeeSearch';
import { directoryPreferencesKey, parseDirectoryPreferences, sortDirectoryEmployees, type DirectoryPreferences, type DirectorySort } from './employeeDirectoryModel';
import './employeeDirectory.css';

export type DirectoryEmployee = {
  id: number;
  name: string;
  department: string;
  position: string;
  joinDate: string;
  annualAllowance: number;
  usedDays: number;
  remainingDays: number;
  periodStart: string;
  periodEnd: string;
  allowanceMode: 'auto' | 'manual';
  hasManualOverride: boolean;
  calculationBasis: string;
  automaticAllowance?: number;
};

export type EmployeeDirectoryProps<T extends DirectoryEmployee> = {
  employees: readonly T[];
  onEdit: (employee: T) => void;
  onRecord: (employeeId: number) => void;
  onHistory: (employeeId: number) => void;
  disabled?: boolean;
};

function loadPreferences(): DirectoryPreferences {
  try { return parseDirectoryPreferences(JSON.parse(localStorage.getItem(directoryPreferencesKey) || 'null')); }
  catch { return parseDirectoryPreferences(null); }
}

const dayText = (days: number) => Number.isInteger(days) ? String(days) : days.toFixed(1);
const dateText = (date: string) => date.replaceAll('-', '.');
const employeeLabel = (employee: DirectoryEmployee) => `${employee.name} · ${employee.department || '팀 미지정'} · 입사 ${dateText(employee.joinDate)}`;

export default function EmployeeDirectory<T extends DirectoryEmployee>({ employees, onEdit, onRecord, onHistory, disabled = false }: EmployeeDirectoryProps<T>) {
  const [preferences, setPreferences] = useState(loadPreferences);
  const [query, setQuery] = useState('');
  const [department, setDepartment] = useState('');
  useEffect(() => {
    try { localStorage.setItem(directoryPreferencesKey, JSON.stringify(preferences)); }
    catch { /* Browsers can disable local storage; the selected view still works for this session. */ }
  }, [preferences]);

  const departments = useMemo(() => [...new Set(employees.map((employee) => employee.department).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'ko')), [employees]);
  const visible = useMemo(() => sortDirectoryEmployees(
    searchEmployees(employees, query).filter((employee) => !department || employee.department === department), preferences.sort,
  ), [employees, query, department, preferences.sort]);
  const hasFilters = Boolean(query.trim() || department);
  const resetFilters = () => { setQuery(''); setDepartment(''); };

  function actions(employee: T) {
    const label = employeeLabel(employee);
    return <div className="directory-actions">
      <button type="button" className="directory-action directory-action-primary" disabled={disabled} onClick={() => onRecord(employee.id)} aria-label={`${label} 사용 기록`}><CalendarDays size={14} aria-hidden="true" />사용 기록</button>
      <button type="button" className="directory-action" disabled={disabled} onClick={() => onHistory(employee.id)} aria-label={`${label} 기간 내역`}>기간 내역</button>
      <button type="button" className="directory-action directory-action-edit" disabled={disabled} onClick={() => onEdit(employee)} aria-label={`${label} 수정`}><Pencil size={13} aria-hidden="true" /><span>수정</span></button>
    </div>;
  }

  return <section className="directory" aria-label="직원 목록">
    <div className="directory-toolbar">
      <div className="directory-search">
        <Search size={17} aria-hidden="true" />
        <label className="directory-visually-hidden" htmlFor="directory-search-input">직원 이름 또는 팀 검색</label>
        <input id="directory-search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름 또는 초성으로 직원 찾기" autoComplete="off" />
        {query && <button type="button" onClick={() => setQuery('')} aria-label="직원 검색어 지우기"><X size={15} aria-hidden="true" /></button>}
      </div>
      <div className="directory-filters">
        <label className="directory-select"><span>팀</span><select value={department} onChange={(event) => setDepartment(event.target.value)} aria-label="직원 조회 팀"><option value="">전체 팀</option>{departments.map((team) => <option value={team} key={team}>{team}</option>)}</select></label>
        <label className="directory-select directory-sort"><span>정렬</span><select value={preferences.sort} onChange={(event) => setPreferences((previous) => ({ ...previous, sort: event.target.value as DirectorySort }))} aria-label="직원 정렬 기준"><option value="name-asc">이름순 (가나다)</option><option value="name-desc">이름순 (역순)</option><option value="join-asc">입사일순 (오래된순)</option><option value="join-desc">입사일순 (최근순)</option></select></label>
        <div className="directory-view-switch" role="group" aria-label="직원 보기 방식">
          <button type="button" aria-pressed={preferences.view === 'list'} onClick={() => setPreferences((previous) => ({ ...previous, view: 'list' }))}><List size={16} aria-hidden="true" />목록형</button>
          <button type="button" aria-pressed={preferences.view === 'cards'} onClick={() => setPreferences((previous) => ({ ...previous, view: 'cards' }))}><LayoutGrid size={15} aria-hidden="true" />카드형</button>
        </div>
      </div>
    </div>
    <div className="directory-summary"><p aria-live="polite">{hasFilters ? <>검색 결과 <strong>{visible.length}명</strong><span> / 전체 {employees.length}명</span></> : <>전체 직원 <strong>{employees.length}명</strong></>}</p><span>날짜를 골라 사용 기록을 저장하면 잔여 연차가 차감됩니다.</span></div>
    {visible.length === 0 ? <div className="directory-empty"><UsersRound size={30} strokeWidth={1.5} aria-hidden="true" /><strong>{employees.length ? '조건에 맞는 직원이 없습니다.' : '등록된 직원이 없습니다.'}</strong><p>{employees.length ? '이름·초성이나 팀을 바꿔 다시 찾아보세요.' : '위의 직원 등록 또는 엑셀 일괄 등록으로 직원을 추가해 주세요.'}</p>{hasFilters && <button type="button" className="directory-action" onClick={resetFilters}>검색 조건 초기화</button>}</div>
      : preferences.view === 'list' ? <div className="directory-table-wrap" role="region" aria-label="직원 목록 표, 가로로 스크롤할 수 있습니다" tabIndex={0}>
        <table className="directory-table"><caption className="directory-visually-hidden">직원별 입사일, 발생 연차, 사용 연차와 잔여 연차</caption><thead><tr><th scope="col" className="directory-name-column">직원 이름</th><th scope="col">팀 · 직책</th><th scope="col">입사일</th><th scope="col" className="directory-number">발생 연차</th><th scope="col" className="directory-number">사용</th><th scope="col" className="directory-number">잔여</th><th scope="col" className="directory-action-heading">관리</th></tr></thead><tbody>{visible.map((employee) => <tr key={employee.id}>
          <th scope="row" className="directory-name-column"><span className="directory-employee-name">{employee.name}</span></th>
          <td><span className="directory-team">{employee.department || '팀 미지정'}</span>{employee.position && <small className="directory-position">{employee.position}</small>}</td>
          <td className="directory-date">{dateText(employee.joinDate)}</td>
          <td className="directory-number" title={employee.calculationBasis}><span className="directory-grant">{dayText(employee.annualAllowance)}<small>일</small></span><small className={`directory-grant-mode ${employee.hasManualOverride || employee.allowanceMode === 'manual' ? 'directory-manual' : ''}`}>{employee.hasManualOverride || employee.allowanceMode === 'manual' ? '직접 설정' : '자동 계산'}</small></td>
          <td className="directory-number directory-used">{dayText(employee.usedDays)}<small>일</small></td>
          <td className="directory-number"><strong className={`directory-remaining${employee.remainingDays < 0 ? ' directory-negative' : ''}`}>{dayText(employee.remainingDays)}<small>일</small></strong></td>
          <td>{actions(employee)}</td>
        </tr>)}</tbody></table>
      </div> : <div className="directory-cards">{visible.map((employee) => <article className="directory-card" key={employee.id}>
        <div className="directory-card-heading"><div className="directory-avatar" aria-hidden="true">{employee.name.slice(0, 1)}</div><div><h2>{employee.name}</h2><p>{employee.department || '팀 미지정'}{employee.position ? ` · ${employee.position}` : ''}</p></div><span className={`directory-mode-badge ${employee.hasManualOverride || employee.allowanceMode === 'manual' ? 'directory-manual' : ''}`}>{employee.hasManualOverride || employee.allowanceMode === 'manual' ? '직접 설정' : '자동 계산'}</span></div>
        <dl className="directory-card-dates"><div><dt>입사일</dt><dd>{dateText(employee.joinDate)}</dd></div><div><dt>사용 기간</dt><dd>{dateText(employee.periodStart)} ~ {dateText(employee.periodEnd)}</dd></div></dl>
        <div className="directory-card-balance"><div><span>잔여 연차</span><strong className={employee.remainingDays < 0 ? 'directory-negative' : ''}>{dayText(employee.remainingDays)}<small>일</small></strong></div><div className="directory-card-stats"><span>발생 <b>{dayText(employee.annualAllowance)}일</b></span><span>사용 <b>{dayText(employee.usedDays)}일</b></span></div></div>
        <div className="directory-card-track" role="img" aria-label={`발생 ${dayText(employee.annualAllowance)}일 중 ${dayText(employee.usedDays)}일 사용`}><span style={{ width: `${employee.annualAllowance > 0 ? Math.min(100, Math.max(0, employee.usedDays / employee.annualAllowance * 100)) : 0}%` }} /></div>
        <div className="directory-card-footer">{actions(employee)}</div>
      </article>)}</div>}
  </section>;
}
