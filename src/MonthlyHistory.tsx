import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Coffee, History, RefreshCw } from 'lucide-react';
import EmployeePicker, { type EmployeeOption } from './EmployeePicker';
import './monthlyHistory.css';

type LeaveType = 'annual' | 'half_am' | 'half_pm';
type Status = 'approved' | 'pending' | 'cancelled' | 'rejected';
type HistoryRecord = {
  id: number;
  employeeId: number;
  employeeName: string;
  department: string;
  startDate: string;
  endDate: string;
  type: LeaveType;
  days: number;
  monthDays: number;
  status: Status;
  reason: string;
  reviewNote: string;
  includesWeekends: boolean;
};
type UsedDate = { date: string; days: number; requestId: number; type: LeaveType; reason: string };
type HistoryResponse = {
  employee: { id: number; name: string; department: string; joinDate: string };
  month: string;
  records: HistoryRecord[];
  usedDays: number;
  pendingDays: number;
  usedDates: UsedDate[];
};
type Props = {
  employees: readonly EmployeeOption[];
  employeeId: string;
  onEmployeeChange: (id: string) => void;
  month: string;
  onMonthChange: (value: string) => void;
  refreshKey?: number;
};

const typeLabels: Record<LeaveType, string> = { annual: '연차', half_am: '오전 반차', half_pm: '오후 반차' };
const statusLabels: Record<Status, string> = { approved: '사용', pending: '이전 기록', cancelled: '취소', rejected: '과거 반려' };
const dayCount = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1);
const seoulToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
const seoulMonth = () => seoulToday().slice(0, 7);

function shiftMonth(month: string, offset: number) {
  const [year, value] = month.split('-').map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(value)) return month;
  const date = new Date(Date.UTC(year, value - 1 + offset, 1));
  return date.toISOString().slice(0, 7);
}

function visibleRange(record: HistoryRecord, month: string, usedDates: UsedDate[]) {
  const [year, value] = month.split('-').map(Number);
  const first = `${month}-01`;
  const last = new Date(Date.UTC(year, value, 0)).toISOString().slice(0, 10);
  const start = record.startDate < first ? first : record.startDate;
  const end = record.endDate > last ? last : record.endDate;
  let dates = [...new Set(usedDates.filter(entry => entry.requestId === record.id).map(entry => entry.date))].sort();
  if (!dates.length) {
    for (const date = new Date(`${start}T00:00:00Z`); date <= new Date(`${end}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1)) {
      if (record.includesWeekends === false && [0, 6].includes(date.getUTCDay())) continue;
      dates.push(date.toISOString().slice(0, 10));
    }
  }
  const readable = (date: string) => `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일`;
  const ranges: { first: string; last: string }[] = [];
  for (const date of dates) {
    const previous = ranges[ranges.length - 1];
    if (previous && new Date(`${date}T00:00:00Z`).getTime() - new Date(`${previous.last}T00:00:00Z`).getTime() === 86400000) previous.last = date;
    else ranges.push({ first: date, last: date });
  }
  return ranges.map(range => range.first === range.last ? readable(range.first) : `${readable(range.first)} ~ ${readable(range.last)}`).join(', ') || '—';
}

function dateLabel(date: string) {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${date}T00:00:00Z`));
}

export default function MonthlyHistory({ employees, employeeId, onEmployeeChange, month, onMonthChange, refreshKey = 0 }: Props) {
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [includeOther, setIncludeOther] = useState(false);
  const [retry, setRetry] = useState(0);
  const selectedEmployee = employees.find(employee => String(employee.id) === employeeId);

  useEffect(() => {
    setHistory(null);
    setError('');
    if (!employeeId || !/^\d{4}-\d{2}$/.test(month)) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    void fetch(`/api/employees/${encodeURIComponent(employeeId)}/leave-history?month=${encodeURIComponent(month)}`, { signal: controller.signal })
      .then(async response => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || '월별 사용 내역을 불러오지 못했습니다.');
        if (!body || String(body.employee?.id) !== employeeId || body.month !== month || !Array.isArray(body.records) || !Array.isArray(body.usedDates)) throw new Error('월별 사용 내역을 확인하지 못했습니다. 다시 시도해 주세요.');
        return body as HistoryResponse;
      })
      .then(result => { if (!controller.signal.aborted) setHistory(result); })
      .catch(caught => { if (!controller.signal.aborted) setError((caught as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [employeeId, month, refreshKey, retry]);

  const dates = useMemo(() => {
    const grouped = new Map<string, { date: string; days: number; types: Set<LeaveType>; reasons: Set<string> }>();
    for (const entry of history?.usedDates ?? []) {
      if (!entry.date.startsWith(`${month}-`)) continue;
      const item = grouped.get(entry.date) ?? { date: entry.date, days: 0, types: new Set<LeaveType>(), reasons: new Set<string>() };
      item.days += entry.days;
      item.types.add(entry.type);
      if (entry.reason) item.reasons.add(entry.reason);
      grouped.set(entry.date, item);
    }
    return [...grouped.values()].sort((left, right) => left.date.localeCompare(right.date));
  }, [history, month]);
  const records = [...(history?.records ?? [])].filter(record => includeOther || record.status === 'approved')
    .sort((left, right) => left.startDate.localeCompare(right.startDate) || left.id - right.id);
  const [year, monthNumber] = month.split('-').map(Number);
  const today = seoulToday();
  const futureDays = dates.filter(entry => entry.date > today).reduce((sum, entry) => sum + entry.days, 0);
  const recordStatus = (record: HistoryRecord) => record.status === 'approved' ? record.startDate > today ? '예정' : record.endDate > today ? '사용·예정' : '사용' : statusLabels[record.status];

  return <div className="monthly-history">
    <section className="panel monthly-history-controls" aria-label="직원별 월별 조회 조건">
      <EmployeePicker employees={employees} value={employeeId} onChange={onEmployeeChange} label="내역을 볼 직원 이름" />
      <div className="monthly-history-month">
        <label htmlFor="employee-history-month">조회 월</label>
        <div className="monthly-history-month-input">
          <button className="icon-button" aria-label="이전 달 내역" disabled={month <= '1900-01'} onClick={() => onMonthChange(shiftMonth(month, -1))}><ChevronLeft size={19} /></button>
          <input id="employee-history-month" type="month" aria-label="조회 월" min="1900-01" max="2100-12" value={month} onChange={event => { if (event.target.value) onMonthChange(event.target.value); }} />
          <button className="icon-button" aria-label="다음 달 내역" disabled={month >= '2100-12'} onClick={() => onMonthChange(shiftMonth(month, 1))}><ChevronRight size={19} /></button>
        </div>
      </div>
      <button className="button secondary small monthly-history-today" onClick={() => onMonthChange(seoulMonth())}>이번 달</button>
    </section>

    {!employeeId ? <section className="panel monthly-history-empty"><History size={34} strokeWidth={1.4} /><h2>직원을 선택해 주세요.</h2><p>이름을 검색하면 사용한 날짜와 일수를 월별로 볼 수 있습니다.</p>{employees.length === 0 && <small>직원 관리에서 직원을 먼저 등록해 주세요.</small>}</section>
      : loading ? <section className="panel monthly-history-loading" role="status"><span className="spinner" />월별 사용 내역을 불러오고 있습니다.</section>
        : error ? <section className="panel monthly-history-empty" role="alert"><p>{error}</p><button className="button secondary" onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} />다시 시도</button></section>
          : history && <>
            <div className="monthly-history-heading"><div><span>{history.employee.department || selectedEmployee?.department || '부서 미지정'}</span><h2>{history.employee.name} 님의 {year}년 {monthNumber}월 사용 내역</h2></div><p>입사일 {history.employee.joinDate.replaceAll('-', '.')}</p></div>
            <div className="monthly-history-stats" aria-label="월별 연차 요약">
              <section className="panel monthly-history-stat"><span><CalendarDays size={17} />이번 달 사용·예정</span><strong>{dayCount(history.usedDays)}<small>일</small></strong><p>저장한 휴가를 바로 차감한 일수</p></section>
              <section className="panel monthly-history-stat"><span><Coffee size={17} />등록한 날짜</span><strong>{dates.length}<small>일</small></strong><p>같은 날의 반차는 한 날짜로 표시</p></section>
              <section className="panel monthly-history-stat"><span><Clock3 size={17} />이 달 예정 휴가</span><strong>{dayCount(futureDays)}<small>일</small></strong><p>위 사용·예정 합계에 포함됩니다.</p></section>
            </div>
            <section className="panel monthly-history-dates"><div className="monthly-history-section-heading"><h3>사용한 날짜 한눈에 보기</h3><span>주말·공휴일에도 사용 가능</span></div>{dates.length ? <div className="monthly-history-date-list">{dates.map(entry => <div className="monthly-history-date" key={entry.date} title={[...entry.reasons].join(' · ')}><span>{dateLabel(entry.date)}{entry.date > today && <em className="monthly-scheduled-label">예정</em>}</span><strong>{dayCount(entry.days)}일</strong><small>{[...entry.types].map(type => typeLabels[type]).join(' · ')}</small></div>)}</div> : <p className="monthly-history-no-dates">이 달에 등록된 사용·예정 휴가가 없습니다.</p>}</section>
            <section className="panel monthly-history-records"><div className="monthly-history-section-heading"><div><h3>상세 사용 내역</h3><p>여러 달에 걸친 연차는 조회 월에 해당하는 일수만 표시합니다.</p></div><label className="monthly-history-toggle"><input type="checkbox" checked={includeOther} onChange={event => setIncludeOther(event.target.checked)} />취소된 이전 기록도 보기</label></div><div className="monthly-history-table-wrap"><table className="monthly-history-table"><thead><tr><th>이 달 사용 날짜</th><th>유형</th><th>이 달 일수</th><th>상태</th><th>사유·메모</th></tr></thead><tbody>{records.map(record => <tr key={record.id} className={record.status === 'cancelled' || record.status === 'rejected' ? 'inactive' : ''}><td><strong>{visibleRange(record, month, history.usedDates)}</strong>{(record.startDate < `${month}-01` || record.endDate.slice(0, 7) !== month) && <small>전체 기간 {record.startDate} ~ {record.endDate}</small>}</td><td>{typeLabels[record.type]}</td><td><strong>{dayCount(record.monthDays)}일</strong></td><td><span className={`status-badge ${record.status}`}><span />{recordStatus(record)}</span></td><td><span>{record.reason || '—'}</span>{record.reviewNote && <small>{record.reviewNote}</small>}</td></tr>)}</tbody></table></div>{!records.length && <div className="monthly-history-no-records"><Coffee size={25} strokeWidth={1.5} /><p>{includeOther ? '이 달에 등록된 기록이 없습니다.' : '이 달에 등록된 사용·예정 휴가가 없습니다.'}</p></div>}<p className="monthly-history-footnote">예정 휴가도 저장 즉시 차감됩니다. 취소된 이전 기록은 이 달 사용·예정 합계에 포함하지 않습니다.</p></section>
          </>}
  </div>;
}
