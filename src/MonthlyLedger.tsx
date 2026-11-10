import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Download, RefreshCw, Search, Users, X } from 'lucide-react';
import { searchEmployees } from './employeeSearch';
import { createLedgerCsv, ledgerCellDescription, ledgerDayCount, type LedgerResponse } from './monthlyLedgerModel';
import './monthlyLedger.css';

type Props = {
  asOf: string;
  month: string;
  onMonthChange: (month: string) => void;
  onHistory: (employeeId: string, month: string) => void;
  refreshKey?: number;
};

const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
const seoulMonth = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()).slice(0, 7);
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const monthLabel = (month: string) => `${Number(month.slice(0, 4))}년 ${Number(month.slice(5))}월`;
const teamKey = (department: string) => `team:${department}`;

function shiftMonth(month: string, offset: number) {
  const [year, value] = month.split('-').map(Number);
  if (!year || !value) return month;
  return new Date(Date.UTC(year, value - 1 + offset, 1)).toISOString().slice(0, 7);
}

export default function MonthlyLedger({ asOf, month, onMonthChange, onHistory, refreshKey = 0 }: Props) {
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [team, setTeam] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('name');

  useEffect(() => {
    setData(null);
    setError('');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month) || !/^\d{4}-\d{2}-\d{2}$/u.test(asOf)) {
      setError('조회 월과 기준일을 확인해 주세요.');
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({ month, asOf });
    void fetch(`/api/leave-ledger?${params}`, { signal: controller.signal })
      .then(async response => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || '전체 월별 현황을 불러오지 못했습니다.');
        if (!body || body.month !== month || body.asOf !== asOf || !Array.isArray(body.days) || !Array.isArray(body.employees)
          || !body.employees.every((employee: { cells?: unknown }) => Array.isArray(employee.cells))) {
          throw new Error('전체 월별 현황을 확인하지 못했습니다. 다시 시도해 주세요.');
        }
        return body as LedgerResponse;
      })
      .then(body => { if (!controller.signal.aborted) setData(body); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '조회 중 오류가 발생했습니다.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [asOf, month, refreshKey, retry]);

  const ledger = data?.month === month && data?.asOf === asOf ? data : null;
  const teams = useMemo(() => [...new Set(ledger?.employees.map(employee => employee.department) || [])]
    .sort((left, right) => left.localeCompare(right, 'ko')), [ledger]);
  const selectedTeam = teams.some(department => teamKey(department) === team) ? team : '';
  const employees = useMemo(() => {
    const matches = searchEmployees((ledger?.employees || []).filter(employee => !selectedTeam || teamKey(employee.department) === selectedTeam), query);
    if (sort === 'team') matches.sort((left, right) => left.department.localeCompare(right.department, 'ko') || left.name.localeCompare(right.name, 'ko'));
    return matches;
  }, [ledger, selectedTeam, query, sort]);
  const monthUsedDays = employees.reduce((sum, employee) => sum + employee.monthUsedDays, 0);
  const usedEmployeeCount = employees.filter(employee => employee.monthUsedDays > 0).length;
  const dailyTotals = useMemo(() => new Map((ledger?.days || []).map(date => [date, employees.reduce((sum, employee) =>
    sum + (employee.cells.find(cell => cell.date === date)?.days || 0), 0)])), [ledger, employees]);

  function downloadCsv() {
    if (!ledger) return;
    const url = URL.createObjectURL(new Blob([createLedgerCsv(ledger, employees)], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `전체_연차현황_${month}.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="monthly-ledger">
    <section className="panel ledger-controls" aria-label="전체 월별 현황 조회 조건">
      <div className="ledger-month-control">
        <label htmlFor="ledger-month">조회 월</label>
        <div className="ledger-month-input">
          <button type="button" className="icon-button" aria-label="이전 달" disabled={month <= '1900-01'} onClick={() => onMonthChange(shiftMonth(month, -1))}><ChevronLeft size={17} /></button>
          <input id="ledger-month" type="month" value={month} min="1900-01" max="2100-12" onChange={event => { if (event.target.value) onMonthChange(event.target.value); }} />
          <button type="button" className="icon-button" aria-label="다음 달" disabled={month >= '2100-12'} onClick={() => onMonthChange(shiftMonth(month, 1))}><ChevronRight size={17} /></button>
        </div>
      </div>
      <button type="button" className="button secondary ledger-current-month" onClick={() => onMonthChange(seoulMonth())}>이번 달</button>
      <p className="ledger-control-note">한 번 등록한 연차를 직원별·팀별로 함께 확인합니다.</p>
      <button type="button" className="button secondary ledger-export" onClick={downloadCsv} disabled={!ledger || loading || employees.length === 0}><Download size={15} />엑셀용 CSV</button>
    </section>

    {error ? <section className="panel ledger-message" role="alert"><p>{error}</p><button type="button" className="button secondary" onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} />다시 불러오기</button></section>
      : !ledger || loading ? <section className="panel ledger-message" role="status"><span className="spinner" />전체 월별 현황을 불러오는 중입니다.</section>
        : <>
          <div className="ledger-heading"><div><span>직원 전체 연차 대장</span><h2>{monthLabel(month)} 연차 사용현황</h2></div><p>사용하지 않은 직원도 함께 표시합니다.</p></div>
          <div className="ledger-summary-grid" aria-label="현재 조회 범위의 월별 합계">
            <section className="panel ledger-summary"><span><Users size={16} />조회 직원</span><strong>{employees.length}<small>명</small></strong><p>전체 {ledger.employees.length}명 중 현재 검색·팀 범위</p></section>
            <section className="panel ledger-summary"><span><CalendarDays size={16} />월 사용·예정 합계</span><strong>{ledgerDayCount(monthUsedDays)}<small>일</small></strong><p>{monthLabel(month)}에 해당하는 날짜만 집계</p></section>
            <section className="panel ledger-summary"><span><Users size={16} />연차 사용·예정 직원</span><strong>{usedEmployeeCount}<small>명</small></strong><p>반차를 포함해 기록이 있는 직원</p></section>
          </div>
          <section className="panel ledger-panel">
            <div className="ledger-panel-heading"><div><h3>날짜별 연차 사용표</h3><p>직원 이름을 누르면 해당 직원의 사용 내역을 볼 수 있습니다.</p></div><span>{employees.length}명</span></div>
            <div className="ledger-filters">
              <label className="ledger-team-filter"><span>팀</span><select aria-label="월별 현황 팀 선택" value={selectedTeam} onChange={event => setTeam(event.target.value)}><option value="">전체 팀</option>{teams.map(department => <option key={department} value={teamKey(department)}>{department || '미지정'}</option>)}</select></label>
              <label className="ledger-search"><Search size={16} /><input aria-label="월별 현황 직원 검색" placeholder="이름·초성·팀 검색" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="직원 검색 지우기" onClick={() => setQuery('')}><X size={14} /></button>}</label>
              <label className="ledger-sort"><span>정렬</span><select aria-label="월별 현황 정렬" value={sort} onChange={event => setSort(event.target.value)}><option value="name">이름순</option><option value="team">팀·이름순</option></select></label>
            </div>
            <div className="ledger-legend" aria-label="표 기호 안내"><span><b>1</b>연차 1일</span><span><b>0.5</b>반차</span><span><b className="ledger-future-key">예정</b>앞으로 사용할 날짜</span><span>주말·공휴일도 집계</span></div>
            {employees.length ? <div className="ledger-table-wrap" role="region" tabIndex={0} aria-label={`${monthLabel(month)} 전체 직원 날짜별 연차표, 가로로 스크롤할 수 있습니다`}>
              <table className="ledger-table">
                <caption className="ledger-sr-only">{monthLabel(month)} 직원별 일일 연차 사용·예정 현황. 발생과 잔여일수는 {asOf} 기준입니다.</caption>
                <thead><tr><th scope="col" className="ledger-name-col">직원 · 입사일</th><th scope="col" className="ledger-team-col">팀</th><th scope="col" className="ledger-total-col">월 합계</th>{ledger.days.map(date => <th scope="col" key={date} className={`ledger-day-heading${[0, 6].includes(weekday(date)) ? ' ledger-weekend' : ''}`} title={date}><span>{Number(date.slice(8))}</span><small>{weekdays[weekday(date)]}</small></th>)}<th scope="col" className="ledger-balance-col">발생<small>{asOf}</small></th><th scope="col" className="ledger-balance-col">잔여<small>{asOf}</small></th></tr></thead>
                <tbody>{employees.map(employee => {
                  const cells = new Map(employee.cells.map(cell => [cell.date, cell]));
                  return <tr key={employee.id}>
                    <th scope="row" className="ledger-name-col"><button type="button" className="ledger-person" onClick={() => onHistory(String(employee.id), month)} aria-label={`${employee.name} ${employee.department || '미지정'} 연차 사용 내역 보기`}>{employee.name}</button><small>{employee.joinDate}</small></th>
                    <td className="ledger-team-col" title={employee.department || '미지정'}>{employee.department || '미지정'}</td>
                    <td className="ledger-total-col"><strong>{ledgerDayCount(employee.monthUsedDays)}</strong></td>
                    {ledger.days.map(date => {
                      const cell = cells.get(date);
                      const hasFuture = cell?.records.some(record => record.isFuture);
                      const description = cell ? ledgerCellDescription(cell) : `${date}: 사용 기록 없음`;
                      return <td key={date} className={`ledger-day-cell${[0, 6].includes(weekday(date)) ? ' ledger-weekend' : ''}${cell?.days ? ' ledger-used' : ''}${hasFuture ? ' ledger-future' : ''}`} title={description} aria-label={`${employee.name} ${description}`}>
                        {cell?.days ? <span>{ledgerDayCount(cell.days)}{hasFuture && <small>예정</small>}</span> : <span className="ledger-empty-day" aria-hidden="true">·</span>}
                      </td>;
                    })}
                    <td className="ledger-balance-col" title={`기준일 연차 사용기간 ${employee.periodStart} ~ ${employee.periodEnd}`}>{ledgerDayCount(employee.annualAllowance)}</td>
                    <td className="ledger-balance-col" title={`기준일 연차 사용기간 ${employee.periodStart} ~ ${employee.periodEnd}`}>{ledgerDayCount(employee.remainingDays)}</td>
                  </tr>;
                })}</tbody>
                <tfoot><tr><th scope="row" className="ledger-name-col">조회 범위 합계</th><td className="ledger-team-col">{employees.length}명</td><td className="ledger-total-col">{ledgerDayCount(monthUsedDays)}</td>{ledger.days.map(date => <td key={date} className={`ledger-daily-total${[0, 6].includes(weekday(date)) ? ' ledger-weekend' : ''}`} aria-label={`${date} 합계 ${ledgerDayCount(dailyTotals.get(date) || 0)}일`}>{dailyTotals.get(date) ? ledgerDayCount(dailyTotals.get(date)!) : '—'}</td>)}<td className="ledger-balance-col">—</td><td className="ledger-balance-col">—</td></tr></tfoot>
              </table>
            </div> : <div className="ledger-empty"><Users size={27} /><p>{ledger.employees.length ? '검색 조건에 맞는 직원이 없습니다.' : '직원을 등록하면 전체 월별 현황이 표시됩니다.'}</p>{(query || selectedTeam) && <button type="button" className="button secondary small" onClick={() => { setQuery(''); setTeam(''); }}>검색 조건 지우기</button>}</div>}
            <p className="ledger-footnote">월 합계는 선택한 달의 사용일과 예정일을 더한 값입니다. 예정 기록도 잔여 연차에 반영됩니다.<br />발생·잔여는 {asOf} 기준 입사일별 연차 기간의 값으로, 조회 월의 합계와 집계 기간이 다릅니다. 날짜 칸에 마우스를 올리면 반차 구분과 메모를 확인할 수 있습니다.</p>
          </section>
        </>}
  </div>;
}
