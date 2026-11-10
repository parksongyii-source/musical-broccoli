import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, CircleHelp, Coffee, History, RefreshCw } from 'lucide-react';
import EmployeePicker, { type EmployeeOption } from './EmployeePicker';

type LeaveType = 'annual' | 'half_am' | 'half_pm';
type UsedDate = { date: string; days: number; requestId: number; type: LeaveType; reason: string };
type PeriodRecord = {
  id: number; startDate: string; endDate: string; type: LeaveType;
  status: 'approved' | 'pending' | 'cancelled' | 'rejected';
  reason: string; reviewNote: string; periodDays: number;
};
type PeriodResponse = {
  employee: { id: number; name: string; department: string; joinDate: string };
  asOf: string; periodStart: string; periodEnd: string;
  annualAllowance: number; usedDays: number; remainingDays: number;
  records: PeriodRecord[]; usedDates: UsedDate[];
  months: { month: string; usedDays: number; usedDates: UsedDate[] }[];
};
type Props = {
  employees: readonly EmployeeOption[];
  employeeId: string;
  onEmployeeChange: (id: string) => void;
  asOf: string;
  onAsOfChange: (asOf: string) => void;
  refreshKey?: number;
};
const count = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1);
const typeLabels: Record<LeaveType, string> = { annual: '연차', half_am: '오전 반차', half_pm: '오후 반차' };
const dateText = (date: string) => date.replaceAll('-', '.');
const seoulToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
const shortDate = (date: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${date}T00:00:00Z`));

export default function PeriodHistory({ employees, employeeId, onEmployeeChange, asOf, onAsOfChange, refreshKey = 0 }: Props) {
  const [history, setHistory] = useState<PeriodResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [showCancelled, setShowCancelled] = useState(false);
  const today = seoulToday();

  useEffect(() => {
    setHistory(null);
    setError('');
    if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    void fetch(`/api/employees/${encodeURIComponent(employeeId)}/leave-period?asOf=${encodeURIComponent(asOf)}`, { signal: controller.signal })
      .then(async response => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || '연차기간 사용내역을 불러오지 못했습니다.');
        if (!body || String(body.employee?.id) !== employeeId || body.asOf !== asOf || !Array.isArray(body.usedDates) || !Array.isArray(body.months) || !Array.isArray(body.records)) throw new Error('연차기간 사용내역을 확인하지 못했습니다. 다시 시도해 주세요.');
        return body as PeriodResponse;
      })
      .then(body => { if (!controller.signal.aborted) setHistory(body); })
      .catch(caught => { if (!controller.signal.aborted) setError((caught as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [employeeId, asOf, refreshKey, retry]);

  const months = useMemo(() => (history?.months ?? []).map(month => {
    const grouped = new Map<string, { date: string; days: number; types: Set<LeaveType>; reasons: Set<string> }>();
    for (const entry of month.usedDates) {
      const date = grouped.get(entry.date) ?? { date: entry.date, days: 0, types: new Set<LeaveType>(), reasons: new Set<string>() };
      date.days += entry.days;
      date.types.add(entry.type);
      if (entry.reason) date.reasons.add(entry.reason);
      grouped.set(entry.date, date);
    }
    return { ...month, dates: [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date)) };
  }), [history]);
  const futureDays = (history?.usedDates ?? []).filter(entry => entry.date > today).reduce((total, entry) => total + entry.days, 0);
  const cancelled = (history?.records ?? []).filter(record => record.status === 'cancelled' || record.status === 'rejected');

  return <div className="period-history">
    <section className="panel monthly-history-controls" aria-label="연차기간 전체 조회 조건">
      <EmployeePicker employees={employees} value={employeeId} onChange={onEmployeeChange} label="내역을 볼 직원 이름" />
      <label className="period-asof">연차기간 기준일<input type="date" aria-label="연차기간 기준일" min="1900-01-01" max="2100-12-31" value={asOf} onChange={event => { if (event.target.value) onAsOfChange(event.target.value); }} /></label>
      <button className="button secondary small" onClick={() => onAsOfChange(today)}>오늘의 연차기간</button>
    </section>
    {!employeeId ? <section className="panel monthly-history-empty"><History size={34} strokeWidth={1.4} /><h2>직원을 선택해 주세요.</h2><p>입사일 기준 연차기간에 사용한 모든 날짜를 월별로 모아 보여드립니다.</p>{!employees.length && <small>직원 관리에서 직원을 먼저 등록해 주세요.</small>}</section>
      : loading ? <section className="panel monthly-history-loading" role="status"><span className="spinner" />연차기간 전체 사용내역을 불러오고 있습니다.</section>
        : error ? <section className="panel monthly-history-empty" role="alert"><p>{error}</p><button className="button secondary" onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} />다시 시도</button></section>
          : history && <>
            <div className="monthly-history-heading"><div><span>{history.employee.department || '부서 미지정'}</span><h2>{history.employee.name} 님의 연차기간 전체 사용내역</h2></div><p>입사일 {dateText(history.employee.joinDate)}</p></div>
            <section className="panel period-overview" aria-label="선택한 연차기간 요약">
              <div className="period-range"><span><CalendarDays size={17} />연차 사용기간</span><strong>{dateText(history.periodStart)} ~ {dateText(history.periodEnd)}</strong><small>기준일 {dateText(asOf)}에 해당하는 입사일 기준 기간</small></div>
              <div><span>발생·부여</span><strong>{count(history.annualAllowance)}<small>일</small></strong></div>
              <div><span>등록 사용·예정</span><strong>{count(history.usedDays)}<small>일</small></strong><small>이 중 예정 {count(futureDays)}일</small></div>
              <div><span>잔여 연차</span><strong>{count(history.remainingDays)}<small>일</small></strong></div>
            </section>
            <section className="panel period-months-panel">
              <div className="monthly-history-section-heading"><div><h3>사용한 날짜 한눈에 보기</h3><p>연차기간에 해당하는 모든 월을 표시합니다. 같은 날의 오전·오후 반차는 합산합니다.</p></div><span>주말·공휴일 사용 가능</span></div>
              <div className="period-months">{months.map(month => <section className={`period-month ${month.dates.length ? 'has-records' : ''}`} key={month.month} aria-label={`${month.month} 연차 사용날짜`}>
                <div className="period-month-title"><h4>{Number(month.month.slice(0, 4))}년 {Number(month.month.slice(5, 7))}월</h4><strong>{count(month.usedDays)}일</strong></div>
                {month.dates.length ? <div className="period-date-list">{month.dates.map(entry => <div className={`period-date ${entry.date > today ? 'scheduled' : ''}`} key={entry.date} title={[...entry.reasons].join(' · ')} data-date={entry.date}><span>{shortDate(entry.date)}{entry.date > today && <em>예정</em>}</span><strong>{count(entry.days)}일</strong><small>{[...entry.types].map(type => typeLabels[type]).join(' · ')}</small></div>)}</div> : <p className="period-no-dates">등록한 날짜 없음</p>}
              </section>)}</div>
              {!history.usedDates.length && <p className="period-empty-note"><Coffee size={17} />이 연차기간에는 등록된 사용·예정 휴가가 없습니다.</p>}
              <p className="monthly-history-footnote"><CircleHelp size={13} />예정 휴가도 저장 즉시 차감되며 취소하면 잔여 연차가 복원됩니다. 취소된 날짜는 위 합계에서 제외됩니다.</p>
            </section>
            {cancelled.length > 0 && <section className="panel period-cancelled"><label className="monthly-history-toggle"><input type="checkbox" checked={showCancelled} onChange={event => setShowCancelled(event.target.checked)} />취소된 이전 기록 {cancelled.length}건 보기</label>{showCancelled && <ul>{cancelled.map(record => <li key={record.id}><strong>{dateText(record.startDate)}{record.startDate !== record.endDate && ` ~ ${dateText(record.endDate)}`}</strong><span>{typeLabels[record.type]} · {count(record.periodDays)}일 · {record.status === 'rejected' ? '과거 반려' : '취소'}</span><small>{record.reviewNote || record.reason || '메모 없음'}</small></li>)}</ul>}</section>}
          </>}
  </div>;
}
