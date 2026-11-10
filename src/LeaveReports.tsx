import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { ArrowRight, BarChart3, CalendarDays, ChevronLeft, ChevronRight, CircleHelp, Coffee, RefreshCw, Search, UsersRound, X } from 'lucide-react';
import { searchEmployees } from './employeeSearch';
import MonthlyLedger from './MonthlyLedger';
import './leaveReports.css';

export type ReportMode = 'teams' | 'usage' | 'ledger';

type ReportTotals = {
  employeeCount: number;
  annualAllowance: number;
  usedDays: number;
  pendingDays: number;
  remainingDays: number;
  usageRate: number | null;
  monthUsedDays: number;
  monthPendingDays: number;
  monthUsedEmployeeCount: number;
};
type TeamReport = ReportTotals & { department: string };
type EmployeeReport = {
  id: number;
  name: string;
  department: string;
  position: string;
  joinDate: string;
  periodStart: string;
  periodEnd: string;
  annualAllowance: number;
  usedDays: number;
  pendingDays: number;
  remainingDays: number;
  usageRate: number | null;
  automaticAllowance: number;
  hasManualOverride: boolean;
  calculationBasis: string;
  accrualDate: string | null;
  lastAccrualDate: string | null;
  nextAccrualDate: string | null;
  grantDateType: 'annual' | 'monthly' | 'none';
  monthUsedDays: number;
  monthPendingDays: number;
  expiryDate: string;
  daysUntilExpiry: number;
  currentRemainingDays: number;
  isUrgent: boolean;
};
type ReportResponse = {
  today: string;
  urgentWindowDays: number;
  asOf: string;
  month: string;
  summary: ReportTotals;
  teams: TeamReport[];
  employees: EmployeeReport[];
};
type Props = {
  asOf: string;
  month: string;
  onMonthChange: (month: string) => void;
  mode: ReportMode;
  onModeChange: (mode: ReportMode) => void;
  onHistory: (employeeId: string, month: string) => void;
  onPeriodHistory: (employeeId: string, asOf: string) => void;
  refreshKey?: number;
};

const number = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1);
const percentage = (value: number | null) => value === null || !Number.isFinite(value) ? '—' : `${number(value)}%`;
const dateLabel = (value: string | null) => value ? value.replaceAll('-', '.') : '발생 전';

function shiftMonth(month: string, offset: number) {
  const [year, value] = month.split('-').map(Number);
  return new Date(Date.UTC(year, value - 1 + offset, 1)).toISOString().slice(0, 7);
}

function UsageBar({ value }: { value: number | null }) {
  const valid = value !== null && Number.isFinite(value);
  return <div className={`report-usage ${valid && value > 100 ? 'overdrawn' : ''}`}>
    <strong>{percentage(value)}</strong>
    <div className="report-usage-track" aria-hidden="true"><span style={{ width: `${valid ? Math.max(0, Math.min(100, value)) : 0}%` }} /></div>
    {!valid && <small>부여 0일</small>}
  </div>;
}

function ReportEmpty({ children }: { children: string }) {
  return <div className="report-empty"><Coffee size={28} strokeWidth={1.4} /><p>{children}</p></div>;
}

export default function LeaveReports({ asOf, month, onMonthChange, mode, onModeChange, onHistory, onPeriodHistory, refreshKey = 0 }: Props) {
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [department, setDepartment] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (mode === 'ledger') { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setReport(null);
    void fetch(`/api/leave-reports?asOf=${encodeURIComponent(asOf)}&month=${encodeURIComponent(month)}`, { signal: controller.signal })
      .then(async response => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || '연차 통계를 불러오지 못했습니다.');
        if (!body || body.asOf !== asOf || body.month !== month || !body.summary || !Array.isArray(body.teams) || !Array.isArray(body.employees)) throw new Error('통계 조회 결과를 확인하지 못했습니다. 다시 시도해 주세요.');
        return body as ReportResponse;
      })
      .then(body => {
        if (controller.signal.aborted) return;
        setReport(body);
        setDepartment(current => current === 'all' || body.teams.some(team => team.department === current) ? current : 'all');
      })
      .catch(caught => { if (!controller.signal.aborted) setError((caught as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [asOf, month, refreshKey, retry, mode === 'ledger']);

  const teams = report?.teams ?? [];
  const selectedTeam = teams.find(team => team.department === department);
  const scope = selectedTeam ?? report?.summary;
  const scopedEmployees = (report?.employees ?? []).filter(employee => department === 'all' || employee.department === department);
  const employees = useMemo(() => searchEmployees(scopedEmployees, search), [scopedEmployees, search]);
  const shownTeams = teams.filter(team => department === 'all' || team.department === department);
  const scopeName = selectedTeam?.department || '전체 팀';
  const monthLabel = `${Number(month.slice(0, 4))}년 ${Number(month.slice(5, 7))}월`;

  function tabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const modes: ReportMode[] = ['teams', 'usage', 'ledger'];
    const index = modes.indexOf(mode);
    const next = event.key === 'Home' ? modes[0] : event.key === 'End' ? modes[modes.length - 1] : modes[(index + (event.key === 'ArrowRight' ? 1 : -1) + modes.length) % modes.length];
    onModeChange(next);
    document.getElementById(`report-tab-${next}`)?.focus();
  }

  return <div className="leave-reports">
    <div className="report-tabs" role="tablist" aria-label="연차 통계 보기">
      <button type="button" id="report-tab-teams" role="tab" aria-selected={mode === 'teams'} aria-controls="report-content" tabIndex={mode === 'teams' ? 0 : -1} onKeyDown={tabKey} onClick={() => onModeChange('teams')}><UsersRound size={18} />팀별 사용 현황</button>
      <button type="button" id="report-tab-usage" role="tab" aria-selected={mode === 'usage'} aria-controls="report-content" tabIndex={mode === 'usage' ? 0 : -1} onKeyDown={tabKey} onClick={() => onModeChange('usage')}><BarChart3 size={18} />개인별 사용률</button>
      <button type="button" id="report-tab-ledger" role="tab" aria-selected={mode === 'ledger'} aria-controls="report-content" tabIndex={mode === 'ledger' ? 0 : -1} onKeyDown={tabKey} onClick={() => onModeChange('ledger')}><CalendarDays size={18} />전체 월별 현황</button>
    </div>
    {mode !== 'ledger' && <div className="panel report-controls">
      <label className="report-control">조회 팀<select aria-label="조회 팀" value={department} onChange={event => setDepartment(event.target.value)}><option value="all">전체 팀</option>{teams.map(team => <option value={team.department} key={team.department}>{team.department}</option>)}</select></label>
      <div className="report-month"><label htmlFor="report-month">조회 월의 사용 현황</label><div className="report-month-input"><button className="icon-button" aria-label="통계 이전 달" disabled={month <= '1900-01'} onClick={() => onMonthChange(shiftMonth(month, -1))}><ChevronLeft size={18} /></button><input id="report-month" type="month" aria-label="통계 조회 월" min="1900-01" max="2100-12" value={month} onChange={event => { if (event.target.value) onMonthChange(event.target.value); }} /><button className="icon-button" aria-label="통계 다음 달" disabled={month >= '2100-12'} onClick={() => onMonthChange(shiftMonth(month, 1))}><ChevronRight size={18} /></button></div></div>
      <div className="report-asof"><CalendarDays size={16} /><span>부여·사용률 기준일 <strong>{asOf.replaceAll('-', '.')}</strong></span></div>
    </div>}

    <div role="tabpanel" id="report-content" aria-labelledby={`report-tab-${mode}`} className="report-content">
      {mode === 'ledger' ? <MonthlyLedger asOf={asOf} month={month} onMonthChange={onMonthChange} onHistory={onHistory} refreshKey={refreshKey} /> : loading ? <div className="panel report-loading" role="status"><span className="spinner" />연차 통계를 불러오고 있습니다.</div>
        : error ? <div className="panel report-error" role="alert"><CircleHelp size={27} /><p>{error}</p><button className="button secondary" onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} />다시 시도</button></div>
          : report && scope && <>
            <div className="report-scope-heading"><div><span>{mode === 'teams' ? 'TEAM LEAVE OVERVIEW' : 'INDIVIDUAL LEAVE USAGE'}</span><h2>{scopeName} 연차 현황</h2></div><p>총 {scope.employeeCount}명 · 직원별 입사일 기준 기간의 합계</p></div>
            <div className="report-summary-grid" aria-label={`${scopeName} 연차 요약`}>
              <section className="panel report-summary"><span>발생·부여 연차</span><strong>{number(scope.annualAllowance)}<small>일</small></strong><p>기준일에 해당하는 관리 기간</p></section>
              <section className="panel report-summary"><span>사용 연차</span><strong>{number(scope.usedDays)}<small>일</small></strong><p>관리 기간 사용률 {percentage(scope.usageRate)}</p></section>
              <section className="panel report-summary"><span>잔여 연차</span><strong className={scope.remainingDays < 0 ? 'negative' : ''}>{number(scope.remainingDays)}<small>일</small></strong><p>등록한 사용·예정 휴가를 차감한 일수</p></section>
              <section className="panel report-summary monthly"><span>{monthLabel} 사용</span><strong>{number(scope.monthUsedDays)}<small>일</small></strong><p>{scope.monthUsedEmployeeCount}명 · 등록된 사용·예정 일수</p></section>
            </div>

            {mode === 'teams' && <section className="report-team-section" aria-label="팀별 사용 현황">
              <div className="report-section-heading"><div><h3>팀을 선택해 직원별 현황을 확인하세요.</h3><p>관리 기간 사용률과 조회 월 사용 일수를 함께 표시합니다.</p></div>{department !== 'all' && <button className="button subtle small" onClick={() => setDepartment('all')}>전체 팀 보기</button>}</div>
              {shownTeams.length ? <div className="report-team-grid">{shownTeams.map(team => <button type="button" className={`panel report-team-card ${department === team.department ? 'selected' : ''}`} key={team.department} aria-label={`${team.department} 직원 현황 보기`} aria-pressed={department === team.department} onClick={() => { setDepartment(team.department); setSearch(''); }}>
                <div className="report-team-top"><span className="report-team-icon"><UsersRound size={20} /></span><div><h3>{team.department}</h3><span>{team.employeeCount}명</span></div><ArrowRight size={17} /></div>
                <div className="report-team-rate"><span>관리 기간 사용률</span><UsageBar value={team.usageRate} /></div>
                <div className="report-team-numbers"><div><span>부여</span><strong>{number(team.annualAllowance)}일</strong></div><div><span>사용</span><strong>{number(team.usedDays)}일</strong></div><div><span>잔여</span><strong>{number(team.remainingDays)}일</strong></div></div>
                <div className="report-team-month"><span>{monthLabel} 사용</span><strong>{number(team.monthUsedDays)}일 · {team.monthUsedEmployeeCount}명</strong></div>
              </button>)}</div> : <section className="panel"><ReportEmpty>등록된 팀이 없습니다. 직원을 등록하면 팀별 현황이 표시됩니다.</ReportEmpty></section>}
            </section>}

            <section className="panel report-people-panel">
              <div className="report-section-heading report-people-heading"><div><h3>{mode === 'usage' ? '개인별 연차 발생일과 사용률' : `${scopeName} 소속 직원 현황`}</h3><p>입사일 기준 발생일과 사용률입니다. 상세에서 해당 연차기간의 모든 사용 날짜를 확인하세요.</p></div><span className="report-result-count">{employees.length}명</span></div>
              <div className="report-search-row"><label className="report-search"><Search size={17} /><input aria-label="통계 직원 이름 검색" value={search} onChange={event => setSearch(event.target.value)} placeholder="직원 이름 또는 팀 검색" />{search && <button type="button" aria-label="통계 검색 지우기" onClick={() => setSearch('')}><X size={15} /></button>}</label><p>검색은 직원 목록에만 적용됩니다. 위 합계는 {scopeName} 전체 기준입니다.</p></div>
              {employees.length ? <div className="report-table-wrap"><table className="report-table"><thead><tr><th>직원 / 팀</th><th>연차 발생일</th><th>발생·부여</th><th>등록 사용·예정</th><th>잔여</th><th>관리 기간 사용률</th><th>{Number(month.slice(5, 7))}월 사용</th><th>상세</th></tr></thead><tbody>{employees.map(employee => <tr key={employee.id} data-employee-id={employee.id}>
                <td><strong className="report-person-name">{employee.name}<span>{employee.position}</span></strong><span>{employee.department}</span><small>입사 {dateLabel(employee.joinDate)}</small><small>기간 {dateLabel(employee.periodStart)} ~ {dateLabel(employee.periodEnd)}</small></td>
                <td className="report-accrual"><strong>{dateLabel(employee.accrualDate)}</strong><span className={`report-grant-tag ${employee.grantDateType}`}>{employee.grantDateType === 'monthly' ? '월별 발생' : employee.grantDateType === 'annual' ? '연간 발생' : '발생 전'}</span>{employee.nextAccrualDate && <small>다음 {dateLabel(employee.nextAccrualDate)}</small>}{employee.hasManualOverride && <small className="report-manual-note">입사일 기준 발생일 · 직접 설정 일수 적용</small>}</td>
                <td><strong>{number(employee.annualAllowance)}일</strong>{employee.hasManualOverride && <small>직접 설정</small>}</td><td><strong>{number(employee.usedDays)}일</strong></td><td><strong className={employee.isUrgent ? 'urgent-remaining' : employee.remainingDays < 0 ? 'negative' : ''}>{number(employee.remainingDays)}일</strong>{employee.isUrgent && <><small className="urgent-expiry">기한까지 {employee.daysUntilExpiry}일 · 마감 {dateLabel(employee.expiryDate)}</small>{asOf !== report.today && <small className="urgent-today">오늘 기준 잔여 {number(employee.currentRemainingDays)}일</small>}</>}</td><td><UsageBar value={employee.usageRate} /></td><td><strong>{number(employee.monthUsedDays)}일</strong></td><td><button className="button secondary small" aria-label={`${employee.name} ${employee.department} 기간 전체 내역`} onClick={() => onPeriodHistory(String(employee.id), asOf)}>기간 전체 내역<ArrowRight size={13} /></button></td>
              </tr>)}</tbody></table></div> : <ReportEmpty>{report.employees.length ? '검색 조건에 맞는 직원이 없습니다.' : '직원을 등록하면 개인별 발생일과 사용률이 표시됩니다.'}</ReportEmpty>}
              <div className="report-footnote"><CircleHelp size={14} /><p>사용률 = 사용 일수 ÷ 발생·부여 일수 × 100입니다. 팀 사용률은 합계 일수로 계산하며, 개인 사용률의 평균이 아닙니다. 등록된 예정 휴가도 차감·사용률에 포함하며, 취소된 기록은 제외합니다. 빨간 밑줄은 실제 오늘 기준 사용기한 60일 이내이며 잔여가 있는 현재 연차기간입니다.</p></div>
            </section>
          </>}
    </div>
  </div>;
}
