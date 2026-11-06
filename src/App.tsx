import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, CalendarDays, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Coffee, Download, LayoutDashboard, Leaf, Pencil, Plus, Search, ShieldCheck, Sparkles, UsersRound, X } from 'lucide-react';

type AllowanceMode = 'auto' | 'manual';
type Entitlement = { automaticAllowance: number; completedYears: number; completedMonths: number; calculationBasis: string; nextAccrualDate?: string | null; periodStart: string; periodEnd: string; allowanceYear: number };
type Employee = { id: number; name: string; department: string; position: string; joinDate: string; annualAllowance: number; configuredAllowance: number; allowanceYear: number; periodStart: string; periodEnd: string; usedDays: number; pendingDays: number; remainingDays: number; allowanceMode: AllowanceMode; automaticAllowance: number; completedYears: number; completedMonths: number; calculationBasis: string; priorManualAllowance: number | null; hasManualOverride: boolean };
type LeaveType = 'annual' | 'half_am' | 'half_pm';
type Status = 'pending' | 'approved' | 'rejected' | 'cancelled';
type Request = { id: number; employeeId: number; employeeName: string; department: string; startDate: string; endDate: string; type: LeaveType; days: number; reason: string; status: Status; createdAt: string; reviewNote: string };
type Bootstrap = { year: number; asOf: string; employees: Employee[]; requests: Request[] };
type DesktopInfo = { standalone: boolean; quitToken?: string; dataDirectory?: string };
type Page = 'dashboard' | 'employees' | 'requests' | 'calendar';
type Modal = { type: 'request'; employeeId?: number } | { type: 'employee'; employee?: Employee } | { type: 'review'; request: Request; status: 'rejected' | 'cancelled' } | null;
const statusLabels: Record<Status, string> = { pending: '승인 대기', approved: '승인 완료', rejected: '반려', cancelled: '취소' };
const typeLabels: Record<LeaveType, string> = { annual: '연차', half_am: '오전 반차', half_pm: '오후 반차' };
const titles: Record<Page, string> = { dashboard: '대시보드', employees: '직원 관리', requests: '휴가 내역', calendar: '휴가 캘린더' };
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
const currentYear = Number(today.slice(0, 4));
const currentMonth = Number(today.slice(5, 7)) - 1;
const dateText = (value: string) => value.slice(5).replace('-', '.');
const dayCount = (value: number) => Number.isInteger(value) ? `${value}` : value.toFixed(1);
const dateRange = (r: Request) => r.startDate.slice(0, 4) !== r.endDate.slice(0, 4) ? `${r.startDate.replaceAll('-', '.')} — ${r.endDate.replaceAll('-', '.')}` : r.startDate === r.endDate ? dateText(r.startDate) : `${dateText(r.startDate)} — ${dateText(r.endDate)}`;
function weekdayCount(start: string, end: string) {
  if (!start || !end || start > end) return 0;
  const a = new Date(`${start}T00:00:00Z`), b = new Date(`${end}T00:00:00Z`);
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime()) || (b.getTime() - a.getTime()) / 86400000 > 366) return 0;
  let count = 0;
  for (const d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) if (![0, 6].includes(d.getUTCDay())) count++;
  return count;
}
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return body as T;
}
function AllowanceBadge({ mode }: { mode: AllowanceMode }) { return <span className={`allowance-badge ${mode === 'manual' ? 'manual' : 'auto'}`}>{mode === 'manual' ? '직접 설정' : '자동 계산'}</span>; }
function Avatar({ name, id }: { name: string; id: number }) { return <span className={`person-avatar avatar-${id % 8}`} aria-hidden="true">{name.slice(0, 1)}</span>; }
function Badge({ status }: { status: Status }) { return <span className={`status-badge ${status}`}><span />{statusLabels[status]}</span>; }
function Empty({ children }: { children: ReactNode }) { return <div className="empty-state"><Coffee size={27} strokeWidth={1.5} /><p>{children}</p></div>; }

export default function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const [asOf, setAsOf] = useState(today);
  const year = Number(asOf.slice(0, 4));
  const [calendarYear, setCalendarYear] = useState(currentYear);
  const [month, setMonth] = useState(currentMonth);
  const [data, setData] = useState<Bootstrap>({ year: currentYear, asOf: today, employees: [], requests: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('all');
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all');
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [desktop, setDesktop] = useState<DesktopInfo>({ standalone: false });
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const [closed, setClosed] = useState(false);
  const latestLoad = useRef(0);
  async function load(selectedAsOf = asOf) {
    const ticket = ++latestLoad.current;
    setLoadError('');
    try {
      const result = await api<Bootstrap>(`/api/bootstrap?asOf=${selectedAsOf}`);
      if (ticket === latestLoad.current) setData(result);
    } catch (error) { if (ticket === latestLoad.current) setLoadError((error as Error).message); }
    finally { if (ticket === latestLoad.current) setLoading(false); }
  }
  useEffect(() => { setLoading(true); void load(asOf); }, [asOf]);
  useEffect(() => {
    void api<DesktopInfo>('/api/desktop-info').then(setDesktop).catch(() => {});
  }, []);
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(null), 4000); return () => clearTimeout(id); }, [toast]);
  async function quitDesktop() {
    if (!desktop.quitToken || quitting) return;
    setQuitting(true);
    try {
      await api('/api/desktop-quit', { method: 'POST', headers: { 'X-Onhyu-Token': desktop.quitToken }, body: '{}' });
      setClosed(true);
    } catch (error) {
      setToast({ text: (error as Error).message, error: true });
      setConfirmQuit(false);
    } finally { setQuitting(false); }
  }
  function navigate(next: Page) { setPage(next); setSearch(''); setDepartment('all'); setStatusFilter('all'); }
  async function mutate(path: string, method: string, payload: unknown, success: string) {
    setBusy(true);
    try {
      await api(path, { method, body: JSON.stringify(payload) });
      await load();
      setToast({ text: success });
    } finally { setBusy(false); }
  }
  async function review(r: Request, status: 'approved' | 'rejected' | 'cancelled') {
    if (status !== 'approved') { setModal({ type: 'review', request: r, status }); return; }
    try { await mutate(`/api/requests/${r.id}`, 'PATCH', { status }, '휴가 신청을 승인했습니다.'); }
    catch (error) { setToast({ text: (error as Error).message, error: true }); }
  }
  const { employees, requests } = data;
  const pending = requests.filter(r => r.status === 'pending');
  const approved = requests.filter(r => r.status === 'approved');
  const used = employees.reduce((sum, e) => sum + e.usedDays, 0);
  const allowance = employees.reduce((sum, e) => sum + e.annualAllowance, 0);
  const usage = allowance ? Math.round(used / allowance * 100) : 0;
  const todayOff = approved.filter(r => r.startDate <= asOf && r.endDate >= asOf && weekdayCount(asOf, asOf) > 0);
  const upcoming = approved.filter(r => r.endDate >= asOf).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const departments = [...new Set(employees.map(e => e.department))].sort();
  const filteredEmployees = employees.filter(e => `${e.name} ${e.department} ${e.position}`.includes(search.trim()) && (department === 'all' || e.department === department));
  const filteredRequests = requests.filter(r => `${r.employeeName} ${r.department} ${r.reason}`.includes(search.trim()) && (department === 'all' || r.department === department) && (statusFilter === 'all' || r.status === statusFilter));
  const prettyToday = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(`${asOf}T00:00:00+09:00`));
  function exportCsv() {
    const rows = [['이름', '부서', '휴가 유형', '시작일', '종료일', '일수', '상태', '사유'], ...filteredRequests.map(r => [r.employeeName, r.department, typeLabels[r.type], r.startDate, r.endDate, r.days, statusLabels[r.status], r.reason])];
    const content = '\uFEFF' + rows.map(row => row.map(v => { const text = String(v); const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text; return `"${safe.replaceAll('"', '""')}"`; }).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a'); link.href = url; link.download = `온휴_휴가내역_${year}.csv`; link.click(); URL.revokeObjectURL(url);
  }
  const nav = [{ page: 'dashboard' as Page, icon: LayoutDashboard, name: '대시보드' }, { page: 'employees' as Page, icon: UsersRound, name: '직원 관리' }, { page: 'requests' as Page, icon: CalendarDays, name: '휴가 내역' }, { page: 'calendar' as Page, icon: CalendarDays, name: '휴가 캘린더' }];
  if (closed) return <main className="desktop-closed"><span className="brand-mark"><Leaf size={28} /></span><h1>온휴를 종료했습니다.</h1><p>직원과 휴가 자료가 이 컴퓨터에 저장되었습니다.<br />이 브라우저 탭을 닫으셔도 됩니다.</p><p>다시 사용하려면 Onhyu.exe를 더블클릭하세요.</p></main>;
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('dashboard'); }} aria-label="온휴 대시보드"><span className="brand-mark"><Leaf size={24} /></span><span className="brand-copy">온휴<span>팀을 위한 편안한 휴가 관리</span></span></a>
      <div className="workspace-label">WORKSPACE</div>
      <nav aria-label="주 메뉴">{nav.map(item => <button key={item.page} aria-label={item.name} aria-current={page === item.page ? 'page' : undefined} className={`nav-item ${page === item.page ? 'active' : ''}`} onClick={() => navigate(item.page)}><item.icon size={19} /><span>{item.name}</span>{item.page === 'requests' && pending.length > 0 && <span className="nav-count">{pending.length}</span>}</button>)}</nav>
      <div className="sidebar-help"><span className="help-icon"><Sparkles size={20} /></span><strong>잘 쉬는 팀이, 더 멀리 가요.</strong><p>복잡한 연차 관리는 온휴에 맡기고<br />우리 팀의 다음을 준비하세요.</p><span>오늘도 편안한 하루 되세요 <Leaf size={12} /></span></div>
      <div className="sidebar-bottom"><div className="admin-avatar">관</div><div className="admin-info"><strong>관리자</strong><span>우리 회사 워크스페이스</span></div><ShieldCheck size={18} /></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="topbar-breadcrumb">워크스페이스 <ChevronRight size={13} /><strong>{titles[page]}</strong></div><div className="topbar-actions"><span className="demo-tag"><span />관리자용 · 입사일 기준</span><label className="year-select"><CalendarDays size={15} /><span>기준일</span><input type="date" aria-label="조회 기준일" value={asOf} onChange={e => { if (e.target.value) setAsOf(e.target.value); }} /></label></div></header>
      <div className="page-content">
        <div className="page-heading"><div><div className="eyebrow">{page === 'dashboard' ? prettyToday : `입사일 기준 · ${asOf.replaceAll('-', '.')}`}</div><h1>{page === 'dashboard' ? '우리 팀의 쉼을 한눈에' : titles[page]}{page === 'dashboard' && <span className="heading-leaf">🌿</span>}</h1><p>{page === 'dashboard' ? '입사일 기준으로 직원들의 휴가와 남은 연차를 관리하세요.' : page === 'employees' ? '입사일을 입력하면 근속기간에 맞는 연차가 자동 계산됩니다.' : page === 'requests' ? '기준일에 해당하는 직원별 연차 기간의 휴가 내역입니다.' : '기준일에 해당하는 직원별 연차 기간의 일정을 확인하세요.'}</p></div><div className="heading-actions">{page === 'employees' ? <button className="button primary" onClick={() => setModal({ type: 'employee' })}><Plus size={17} />직원 등록</button> : <button className="button primary" onClick={() => setModal({ type: 'request' })} disabled={!employees.length || loading}><Plus size={17} />휴가 등록</button>}</div></div>
        {loadError ? <div className="panel"><Empty>{loadError}<br /><button className="button secondary" onClick={() => { setLoading(true); void load(); }}>다시 시도</button></Empty></div> : loading ? <div className="loading-state" role="status"><span className="spinner" />우리 팀의 휴가를 불러오고 있어요.</div> : <>
          {page === 'dashboard' && <>
            <div className="stats-grid">
              <Stat icon={<UsersRound size={20} />} tone="green" label="전체 직원" value={employees.length} unit="명" caption="함께 일하는 우리 팀" detail="직원 관리" onClick={() => navigate('employees')} />
              <Stat icon={<Clock3 size={20} />} tone="amber" label="승인 대기" value={pending.length} unit="건" caption={pending.length ? '확인이 필요한 신청이 있어요' : '모든 신청을 확인했어요'} detail="신청 확인" onClick={() => { navigate('requests'); setStatusFilter('pending'); }} />
              <Stat icon={<Coffee size={20} />} tone="blue" label={asOf === today ? "오늘 휴가 중" : "기준일 휴가 중"} value={new Set(todayOff.map(r => r.employeeId)).size} unit="명" caption="재충전 중인 팀원" detail="캘린더 보기" onClick={() => navigate('calendar')} />
              <Stat icon={<CalendarDays size={20} />} tone="purple" label="팀 연차 사용률" value={usage} unit="%" caption={`총 ${dayCount(allowance)}일 중 ${dayCount(used)}일 승인`} detail="입사일별 해당 기간 기준" />
            </div>
            <div className="dashboard-grid">
              <section className="panel approval-panel"><div className="panel-header"><div><div className="panel-title">승인을 기다리고 있어요 <span className="count-chip">{pending.length}</span></div><p className="panel-description">팀원들의 휴가 신청을 확인해 주세요.</p></div><button className="panel-link" onClick={() => { navigate('requests'); setStatusFilter('pending'); }}>전체 보기 <ChevronRight size={14} /></button></div><div className="approval-list">{pending.length ? pending.slice(0, 4).map(r => <div className="approval-row" key={r.id}><Avatar name={r.employeeName} id={r.employeeId} /><div className="person-details"><div className="person-name">{r.employeeName}<span>{r.department}</span></div><div className="person-meta">{dateRange(r)} <span className="meta-dot">·</span> {typeLabels[r.type]} {dayCount(r.days)}일</div><p className="request-reason">{r.reason || '사유가 입력되지 않았어요.'}</p></div><div className="row-actions"><button className="button subtle small" disabled={busy} onClick={() => void review(r, 'rejected')}>반려</button><button className="button primary small" disabled={busy} onClick={() => void review(r, 'approved')}><Check size={14} />승인</button></div></div>) : <Empty>기다리는 신청이 없어요.<br />우리 팀의 휴가를 여유롭게 관리해 보세요.</Empty>}</div></section>
              <section className="panel upcoming-panel"><div className="panel-header"><div><div className="panel-title">다가오는 휴가</div><p className="panel-description">미리 확인하는 팀원들의 쉼표</p></div><span className="soft-icon"><CalendarDays size={18} /></span></div><div className="upcoming-list">{upcoming.length ? upcoming.slice(0, 4).map(r => <div className="upcoming-row" key={r.id}><div className="date-tile"><span className="date-month">{Number(r.startDate.slice(5, 7))}월</span><span className="date-day">{Number(r.startDate.slice(8, 10))}</span></div><div className="person-details"><div className="person-name">{r.employeeName} <span>{r.department}</span></div><div className="person-meta">{dateRange(r)} · {typeLabels[r.type]}</div></div><span className="days-chip">{dayCount(r.days)}일</span></div>) : <Empty>다가오는 휴가가 없어요.</Empty>}</div></section>
              <section className="panel balance-panel"><div className="panel-header"><div><div className="panel-title">직원별 연차 현황</div><p className="panel-description">남은 연차를 확인하고, 균형 있게 쉬어 가요.</p></div><button className="panel-link" onClick={() => navigate('employees')}>전체 직원 <ChevronRight size={14} /></button></div><div className="employee-summary-list">{employees.length ? [...employees].sort((a, b) => b.remainingDays - a.remainingDays).slice(0, 5).map(e => <div className="employee-summary-row" key={e.id}><Avatar name={e.name} id={e.id} /><div className="person-details"><div className="person-name">{e.name}<span>{e.department}</span></div><div className="person-meta">부여 {dayCount(e.annualAllowance)}일 · 사용 {dayCount(e.usedDays)}일 <AllowanceBadge mode={e.hasManualOverride ? 'manual' : 'auto'} /></div><div className="person-period">{e.periodStart} ~ {e.periodEnd}</div></div><div className="balance-info"><div><strong>{dayCount(e.remainingDays)}</strong><span> / {dayCount(e.annualAllowance)}일 남음</span></div><div className="balance-track"><span className="balance-fill" style={{ width: `${e.annualAllowance ? Math.max(0, Math.min(100, e.remainingDays / e.annualAllowance * 100)) : 0}%` }} /></div></div></div>) : <Empty>직원을 등록하면 연차 현황이 표시돼요.<br /><button className="button secondary" onClick={() => setModal({ type: 'employee' })}>첫 직원 등록</button></Empty>}</div><div className="panel-footnote"><CircleHelp size={13} />입사일과 근속기간으로 연차를 자동 계산합니다. 승인 대기 일수는 별도로 예약됩니다.</div></section>
              <div className="dashboard-aside"><section className="insight-card"><div className="insight-copy"><span className="insight-label"><Leaf size={13} />ONHYU NOTE</span><h2>좋은 휴식이<br />좋은 내일을 만들어요.</h2><p>충분히 쉬고 돌아온 팀원과 함께<br />더 건강한 일상을 만들어 가세요.</p><button onClick={() => navigate('calendar')}>우리 팀 일정 살펴보기 <ArrowRight size={15} /></button></div><div className="insight-art" aria-hidden="true"><span className="deco-circle" /><Leaf size={76} strokeWidth={1} /><span className="art-spark">✳</span></div></section><div className="guide-note"><ShieldCheck size={18} /><div><strong>데이터는 이 환경에 자동 저장돼요.</strong><p>지금은 관리자용 초기 버전입니다. 직원 접속 기능은 추후 추가할 수 있어요.</p></div></div></div>
            </div>
          </>}
          {page === 'employees' && <><div className="toolbar"><SearchBox value={search} setValue={setSearch} placeholder="직원 이름, 부서, 직책 검색" /><DepartmentSelect departments={departments} value={department} setValue={setDepartment} /><span className="result-count">총 <strong>{filteredEmployees.length}</strong>명</span></div><div className="employee-grid">{filteredEmployees.map(e => <section className="employee-card" key={e.id}><div className="employee-card-top"><Avatar name={e.name} id={e.id} /><button className="icon-button" aria-label={`${e.name} 직원 정보 수정`} onClick={() => setModal({ type: 'employee', employee: e })}><Pencil size={16} /></button></div><h2>{e.name}<span>{e.position}</span></h2><span className="employee-department">{e.department}</span><p className="employee-details">입사일 {e.joinDate.replaceAll('-', '.')} <AllowanceBadge mode={e.hasManualOverride ? 'manual' : 'auto'} /></p><p className="employee-calculation">{e.calculationBasis}{e.hasManualOverride && <> · 자동 기준 {dayCount(e.automaticAllowance)}일</>}</p><p className="employee-period"><span>연차 적용 기간</span>{e.periodStart} ~ {e.periodEnd}</p><div className="employee-balance"><span>잔여 연차</span><strong>{dayCount(e.remainingDays)}<small>일</small></strong></div><div className="balance-track"><span className="balance-fill" style={{ width: `${e.annualAllowance ? Math.max(0, Math.min(100, e.remainingDays / e.annualAllowance * 100)) : 0}%` }} /></div><div className="employee-stats"><div><span>부여</span><strong>{dayCount(e.annualAllowance)}일</strong></div><div><span>사용</span><strong>{dayCount(e.usedDays)}일</strong></div><div><span>대기</span><strong>{dayCount(e.pendingDays)}일</strong></div></div>{e.remainingDays - e.pendingDays < 0 && <p className="allowance-warning">기존 사용·대기 일수가 부여 연차를 넘습니다. 적용 규정을 확인해 주세요.</p>}<button className="button secondary employee-request-button" onClick={() => setModal({ type: 'request', employeeId: e.id })}><Plus size={14} />휴가 등록</button></section>)}</div>{!filteredEmployees.length && <div className="panel"><Empty>검색 결과가 없습니다. 다른 이름이나 부서를 확인해 주세요.</Empty></div>}</>}
          {page === 'requests' && <section className="panel"><div className="status-filter-tabs">{(['all', 'pending', 'approved', 'rejected', 'cancelled'] as const).map(status => <button key={status} className={`filter-tab ${statusFilter === status ? 'active' : ''}`} onClick={() => setStatusFilter(status)}>{status === 'all' ? '전체 내역' : statusLabels[status]}<span>{status === 'all' ? requests.length : requests.filter(r => r.status === status).length}</span></button>)}</div><div className="toolbar table-toolbar"><SearchBox value={search} setValue={setSearch} placeholder="이름, 부서, 사유 검색" /><DepartmentSelect departments={departments} value={department} setValue={setDepartment} /><button className="button secondary small export-button" onClick={exportCsv}><Download size={15} />CSV 내보내기</button></div><div className="table-wrap"><table className="data-table"><thead><tr><th>직원</th><th>휴가 기간</th><th>유형 / 일수</th><th>사유</th><th>상태</th><th>관리</th></tr></thead><tbody>{filteredRequests.map(r => <tr key={r.id}><td><div className="table-person"><Avatar name={r.employeeName} id={r.employeeId} /><div><strong>{r.employeeName}</strong><span>{r.department}</span></div></div></td><td><strong>{dateRange(r)}</strong><span className="table-sub">{r.startDate.slice(0, 4)}년</span></td><td>{typeLabels[r.type]}<span className="table-sub">{dayCount(r.days)}일</span></td><td><div className="reason-cell" title={r.reason}>{r.reason || '—'}</div>{r.reviewNote && <span className="table-sub" title={r.reviewNote}>메모: {r.reviewNote}</span>}</td><td><Badge status={r.status} /></td><td><div className="row-actions">{r.status === 'pending' ? <><button className="button subtle small" disabled={busy} onClick={() => void review(r, 'rejected')}>반려</button><button className="button primary small" disabled={busy} onClick={() => void review(r, 'approved')}>승인</button></> : r.status === 'approved' ? <button className="button subtle small" disabled={busy} onClick={() => void review(r, 'cancelled')}>휴가 취소</button> : <span className="muted">—</span>}</div></td></tr>)}</tbody></table></div>{!filteredRequests.length && <Empty>표시할 휴가 내역이 없습니다.</Empty>}<div className="panel-footnote"><CircleHelp size={13} />연차는 주말을 제외한 평일 기준입니다. 공휴일은 자동 제외되지 않습니다.</div></section>}
          {page === 'calendar' && <section className="panel calendar-panel"><div className="calendar-toolbar"><div className="calendar-title"><button className="icon-button" aria-label="이전 달" onClick={() => { if (month === 0) { setCalendarYear(y => y - 1); setMonth(11); } else setMonth(m => m - 1); }}><ChevronLeft size={19} /></button><h2>{calendarYear}년 {month + 1}월</h2><button className="icon-button" aria-label="다음 달" onClick={() => { if (month === 11) { setCalendarYear(y => y + 1); setMonth(0); } else setMonth(m => m + 1); }}><ChevronRight size={19} /></button><button className="button secondary small" onClick={() => { setCalendarYear(currentYear); setMonth(currentMonth); }}>오늘</button></div><div className="legend"><span><i className="legend-dot" />승인 완료</span><span><i className="legend-dot pending" />승인 대기</span></div></div><Calendar year={calendarYear} month={month} requests={requests} /><div className="panel-footnote"><CircleHelp size={13} />조회 기준일의 입사일별 연차 기간에 해당하는 일정입니다. 다른 기간은 상단 기준일을 변경해 주세요.</div></section>}
        </>}
        <footer className="page-footer"><span><Leaf size={13} />온휴 · 우리 팀의 건강한 쉼을 위해</span><span>입사일 기준 연차 관리 · 토·일 제외, 공휴일 별도 확인</span></footer>
        {desktop.standalone && <div className="desktop-footer"><div><strong>이 컴퓨터에 자동 저장됩니다.</strong><span className="desktop-data-path">저장 폴더: {desktop.dataDirectory}</span></div><button className="button secondary" disabled={busy || quitting} onClick={() => setConfirmQuit(true)}>프로그램 종료</button></div>}
      </div>
    </main>
    <nav className="mobile-nav" aria-label="주 메뉴">{nav.map(item => <button key={item.page} className={`mobile-nav-button ${page === item.page ? 'active' : ''}`} aria-current={page === item.page ? 'page' : undefined} onClick={() => navigate(item.page)}><item.icon size={20} /><span>{item.name}</span></button>)}</nav>
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleHelp size={18} /> : <CheckCheck size={18} />}{toast.text}<button aria-label="알림 닫기" onClick={() => setToast(null)}><X size={15} /></button></div>}
    {modal && <FormModal modal={modal} employees={employees} asOf={asOf} busy={busy} onClose={() => setModal(null)} onSubmit={async (path, method, payload, success) => { await mutate(path, method, payload, success); setModal(null); }} />}
    {confirmQuit && <div className="modal-backdrop"><section className="modal desktop-quit-dialog" role="alertdialog" aria-modal="true" aria-labelledby="quit-title"><div className="modal-header"><h2 id="quit-title">온휴를 종료할까요?</h2></div><p>등록한 자료는 저장되어 다음 실행 때 다시 열립니다.</p><div className="modal-actions"><button className="button secondary" autoFocus disabled={quitting} onClick={() => setConfirmQuit(false)}>계속 사용</button><button className="button primary" disabled={quitting} onClick={() => void quitDesktop()}>{quitting ? '종료 중…' : '프로그램 종료'}</button></div></section></div>}
  </div>;
}
function Stat({ icon, tone, label, value, unit, caption, detail, onClick }: { icon: ReactNode; tone: string; label: string; value: number; unit: string; caption: string; detail: string; onClick?: () => void }) { return <section className="stat-card"><div className="stat-top"><span>{label}</span><span className={`stat-icon tone-${tone}`}>{icon}</span></div><div className="stat-value">{dayCount(value)}<span>{unit}</span></div><p className="stat-caption">{caption}</p>{onClick ? <button className="stat-sub" onClick={onClick}>{detail}<ArrowUpRight size={13} /></button> : <span className="stat-sub">{detail}<ArrowDownRight size={13} /></span>}</section>; }
function SearchBox({ value, setValue, placeholder }: { value: string; setValue: (v: string) => void; placeholder: string }) { return <label className="search-box"><Search size={17} /><input aria-label={placeholder} value={value} onChange={e => setValue(e.target.value)} placeholder={placeholder} />{value && <button aria-label="검색어 지우기" onClick={() => setValue('')}><X size={15} /></button>}</label>; }
function DepartmentSelect({ departments, value, setValue }: { departments: string[]; value: string; setValue: (v: string) => void }) { return <select className="filter-select" aria-label="부서 필터" value={value} onChange={e => setValue(e.target.value)}><option value="all">전체 부서</option>{departments.map(d => <option key={d}>{d}</option>)}</select>; }
function Calendar({ year, month, requests }: { year: number; month: number; requests: Request[] }) {
  const first = new Date(Date.UTC(year, month, 1));
  const start = new Date(first); start.setUTCDate(1 - first.getUTCDay());
  const count = Math.ceil((first.getUTCDay() + new Date(Date.UTC(year, month + 1, 0)).getUTCDate()) / 7) * 7;
  return <div className="calendar-grid">{['일', '월', '화', '수', '목', '금', '토'].map((d, i) => <div key={d} className={`calendar-weekday weekday-${i}`}>{d}</div>)}{Array.from({ length: count }, (_, index) => {
    const date = new Date(start); date.setUTCDate(start.getUTCDate() + index); const iso = date.toISOString().slice(0, 10);
    const events = [0, 6].includes(date.getUTCDay()) ? [] : requests.filter(r => ['approved', 'pending'].includes(r.status) && r.startDate <= iso && r.endDate >= iso);
    return <div key={iso} className={`calendar-cell ${date.getUTCMonth() !== month ? 'outside' : ''} ${iso === today ? 'today' : ''}`}><span className={`calendar-number weekday-${date.getUTCDay()}`}>{date.getUTCDate()}</span>{events.map(r => <div key={r.id} className={`calendar-event ${r.type !== 'annual' ? 'half' : ''} ${r.status === 'pending' ? 'pending' : ''}`} title={`${r.employeeName} · ${typeLabels[r.type]} · ${r.reason}`}><span>{r.employeeName}</span><small>{typeLabels[r.type]}</small></div>)}</div>;
  })}</div>;
}
function FormModal({ modal, employees, asOf, busy, onClose, onSubmit }: { modal: NonNullable<Modal>; employees: Employee[]; asOf: string; busy: boolean; onClose: () => void; onSubmit: (path: string, method: string, payload: unknown, success: string) => Promise<void> }) {
  const employee = modal.type === 'employee' ? modal.employee : undefined;
  const [error, setError] = useState('');
  const [employeeId, setEmployeeId] = useState(String(modal.type === 'request' ? modal.employeeId || employees[0]?.id || '' : ''));
  const [type, setType] = useState<LeaveType>('annual');
  const [startDate, setStartDate] = useState(asOf);
  const [endDate, setEndDate] = useState(asOf);
  const [joinDate, setJoinDate] = useState(employee?.joinDate || asOf);
  const [allowanceMode, setAllowanceMode] = useState<AllowanceMode>(employee?.allowanceMode || 'auto');
  const [manualAllowance, setManualAllowance] = useState(employee ? String(employee.priorManualAllowance ?? employee.configuredAllowance ?? employee.annualAllowance) : '');
  const [manualTouched, setManualTouched] = useState(false);
  const [calculation, setCalculation] = useState<Entitlement | null>(null);
  const [calculationLoading, setCalculationLoading] = useState(modal.type === 'employee');
  const [calculationError, setCalculationError] = useState('');
  useEffect(() => {
    if (modal.type !== 'employee') return;
    const controller = new AbortController();
    setCalculationLoading(true);
    setCalculationError('');
    setCalculation(null);
    if (!joinDate) { setCalculationError('입사일을 입력해 주세요.'); setCalculationLoading(false); return; }
    const timer = window.setTimeout(() => {
      void api<Entitlement>(`/api/entitlement?joinDate=${encodeURIComponent(joinDate)}&asOf=${encodeURIComponent(asOf)}`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) setCalculation(result); })
        .catch(error => { if (!controller.signal.aborted) setCalculationError((error as Error).message); })
        .finally(() => { if (!controller.signal.aborted) setCalculationLoading(false); });
    }, 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [joinDate, asOf, modal.type]);
  function changeAllowanceMode(mode: AllowanceMode) {
    if (mode === 'manual') setManualTouched(true);
    if (mode === 'manual' && manualAllowance === '') setManualAllowance(String(calculation?.automaticAllowance ?? 0));
    setAllowanceMode(mode);
  }
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement;
    closeButton.current?.focus();
    const old = document.body.style.overflow; document.body.style.overflow = 'hidden';
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
      if (e.key === 'Tab') {
        const items = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)');
        if (!items?.length) return; const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = old; document.removeEventListener('keydown', onKey); returnFocus.current?.focus(); };
  }, [busy, onClose]);
  const days = type === 'annual' ? weekdayCount(startDate, endDate) : weekdayCount(startDate, startDate) ? 0.5 : 0;
  const selected = employees.find(e => String(e.id) === employeeId);
  const beforeHire = selected && selected.joinDate > asOf;
  const outsidePeriod = selected && (startDate < selected.periodStart || (type === 'annual' ? endDate : startDate) > selected.periodEnd);
  const title = modal.type === 'employee' ? employee ? '직원 정보 수정' : '새 직원 등록' : modal.type === 'request' ? '휴가 등록' : modal.status === 'rejected' ? '휴가 신청 반려' : '승인된 휴가 취소';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    try {
      if (modal.type === 'employee') {
        if (calculationLoading || calculationError || !calculation) throw new Error(calculationError || '연차 계산을 마칠 때까지 잠시 기다려 주세요.');
        await onSubmit(employee ? `/api/employees/${employee.id}` : '/api/employees', employee ? 'PATCH' : 'POST', { name: form.get('name'), department: form.get('department'), position: form.get('position'), joinDate, allowanceMode, ...(allowanceMode === 'manual' && (!employee || employee.hasManualOverride || manualTouched) ? { annualAllowance: Number(manualAllowance) } : {}), asOf, ...(employee && employee.joinDate === joinDate ? { allowanceYear: employee.allowanceYear } : {}) }, employee ? '직원 정보를 수정했습니다.' : '새 직원을 등록했습니다.');
      }
      else if (modal.type === 'request') {
        if (beforeHire) throw new Error('입사 전 직원입니다. 상단 기준일을 입사일 이후로 바꿔주세요.');
        if (outsidePeriod) throw new Error('조회 중인 연차 기간 안에서 휴가를 등록해 주세요. 다른 기간은 상단 기준일을 변경해 주세요.');
        await onSubmit('/api/requests', 'POST', { employeeId: Number(employeeId), startDate, endDate: type === 'annual' ? endDate : startDate, type, reason: form.get('reason') }, '휴가를 등록했습니다. 승인 후 잔여 연차에 반영됩니다.');
      } else await onSubmit(`/api/requests/${modal.request.id}`, 'PATCH', { status: modal.status, reviewNote: form.get('reviewNote') }, modal.status === 'rejected' ? '휴가 신청을 반려했습니다.' : '휴가를 취소하고 연차를 복원했습니다.');
    } catch (e) { setError((e as Error).message); }
  }
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={dialog}><div className="modal-header"><div><span className="eyebrow">ONHYU WORKSPACE</span><h2 id="modal-title">{title}</h2></div><button className="icon-button modal-close" ref={closeButton} aria-label="창 닫기" disabled={busy} onClick={onClose}><X size={21} /></button></div><form className="modal-form" onSubmit={e => void submit(e)}>
    {modal.type === 'employee' ? <><p className="form-note">입사일만 입력하면 기준일에 맞는 연차가 자동 계산됩니다.</p><div className="form-grid"><label className="form-field">이름 <input className="form-input" name="name" required maxLength={40} defaultValue={employee?.name} placeholder="예: 김온유" /></label><label className="form-field">부서 <input className="form-input" name="department" required maxLength={60} defaultValue={employee?.department} placeholder="예: 경영지원팀" /></label><label className="form-field">직책 <input className="form-input" name="position" maxLength={60} defaultValue={employee?.position} placeholder="예: 매니저" /></label><label className="form-field">입사일 <input className="form-input" name="joinDate" type="date" required value={joinDate} onChange={event => { setCalculationLoading(true); setJoinDate(event.target.value); }} /></label></div><fieldset className="allowance-mode"><legend>연차 부여 방식</legend><label className={allowanceMode === 'auto' ? 'selected' : ''}><input type="radio" name="allowanceMode" value="auto" checked={allowanceMode === 'auto'} onChange={() => changeAllowanceMode('auto')} /><span><strong>입사일 기준 자동 계산</strong><small>근속기간에 따라 연차가 자동으로 늘어납니다.</small></span></label><label className={allowanceMode === 'manual' ? 'selected' : ''}><input type="radio" name="allowanceMode" value="manual" checked={allowanceMode === 'manual'} onChange={() => changeAllowanceMode('manual')} /><span><strong>직접 설정 (회사 규정)</strong><small>회사 규정이나 출근 요건에 맞게 조정합니다.</small></span></label></fieldset><div className="entitlement-preview" aria-live="polite" aria-busy={calculationLoading}><div><span>기준일 {asOf} · 자동 계산 연차</span><strong>{calculationLoading ? <span className="spinner" /> : calculation ? <>{dayCount(calculation.automaticAllowance)}<small>일</small></> : '—'}</strong></div>{calculationLoading ? <p>입사일로 연차를 계산하고 있습니다.</p> : calculationError ? <p className="calculation-error" role="alert">{calculationError}</p> : calculation && <><p>{calculation.calculationBasis}</p><small>적용 기간 {calculation.periodStart} ~ {calculation.periodEnd}</small>{calculation.nextAccrualDate && <small>다음 부여일 {calculation.nextAccrualDate}</small>}</>}</div>{allowanceMode === 'manual' && <label className="form-field">해당 입사일 기간의 부여 연차 (일)<input className="form-input" name="annualAllowance" type="number" required min="0" max="365" step="0.5" value={manualAllowance} onChange={event => { setManualTouched(true); setManualAllowance(event.target.value); }} /><small>{employee && !employee.hasManualOverride && !manualTouched && <>이 기간에는 직접 설정한 값이 없어 자동 기준이 적용 중입니다. 일수를 수정하면 직접 설정으로 저장됩니다.<br /></>}이 기간에만 입력한 일수를 적용합니다. 별도 설정이 없는 다음 기간은 자동 기준으로 계산합니다.</small></label>}<p className="form-note entitlement-policy"><CircleHelp size={14} />1년 미만은 매월 개근 시 1일(최대 11일), 1년 이상은 15일이며 3년 근속부터 2년마다 1일씩 가산해 최대 25일입니다.<br />자동 계산은 개근 및 연간 출근율 80% 요건을 충족한 것으로 가정합니다.</p>{joinDate > asOf && <p className="form-note">입사 전 직원은 기준일의 사용 가능한 연차가 0일입니다.</p>}</> : modal.type === 'request' ? <><div className="form-grid"><label className="form-field wide">직원 선택 <select className="form-input" value={employeeId} onChange={e => setEmployeeId(e.target.value)} required>{employees.map(e => <option key={e.id} value={e.id}>{e.name} · {e.department}</option>)}</select></label><label className="form-field wide">휴가 유형 <select className="form-input" value={type} onChange={e => { setType(e.target.value as LeaveType); if (e.target.value !== 'annual') setEndDate(startDate); }}><option value="annual">연차 · 1일 단위</option><option value="half_am">오전 반차 · 0.5일</option><option value="half_pm">오후 반차 · 0.5일</option></select></label><label className="form-field">시작일 <input className="form-input" type="date" value={startDate} required min={selected?.periodStart} max={selected?.periodEnd} onChange={e => { setStartDate(e.target.value); if (endDate < e.target.value || type !== 'annual') setEndDate(e.target.value); }} /></label><label className="form-field">종료일 <input className="form-input" type="date" value={type === 'annual' ? endDate : startDate} required min={startDate > (selected?.periodStart || '') ? startDate : selected?.periodStart} max={selected?.periodEnd} disabled={type !== 'annual'} onChange={e => setEndDate(e.target.value)} /></label><label className="form-field wide">휴가 사유 <textarea className="form-input" name="reason" rows={3} maxLength={500} placeholder="예: 가족 여행, 개인 일정 (선택)" /></label></div><p className="form-note">선택 직원의 조회 기간: {selected?.periodStart} ~ {selected?.periodEnd}</p>{beforeHire && <div className="form-error" role="status"><CircleHelp size={16} />입사 전 직원입니다. 기준일을 입사일 이후로 바꿔주세요.</div>}<div className="preview-box"><div><span>신청 일수</span><strong>{dayCount(days)}일</strong></div><div><span>조회 기간 신청 가능 연차</span><strong>{dayCount(selected ? selected.remainingDays - selected.pendingDays : 0)}일</strong></div></div><p className="form-note"><CircleHelp size={14} />주말은 제외하며 공휴일은 자동 제외하지 않습니다.<br />조회 기간 안의 휴가를 등록합니다. 다른 기간은 상단 기준일을 변경하세요.<br />입사일 갱신일을 넘기는 휴가는 기간별로 나누어 등록해 주세요.<br />승인 대기 일수는 신청 가능 연차에서 예약됩니다.</p></> : <><div className="review-summary"><Avatar name={modal.request.employeeName} id={modal.request.employeeId} /><div><strong>{modal.request.employeeName} · {typeLabels[modal.request.type]}</strong><p>{dateRange(modal.request)} · {dayCount(modal.request.days)}일</p></div></div><p className="form-note">{modal.status === 'rejected' ? '이 신청을 반려합니다. 사유를 메모로 남겨 주세요.' : '휴가를 취소하면 사용 연차가 복원됩니다. 취소 사유를 남겨 주세요.'}</p><label className="form-field">관리자 메모 <textarea className="form-input" name="reviewNote" rows={3} maxLength={500} placeholder="사유 입력 (선택)" /></label></>}
    {error && <div className="form-error" role="alert"><CircleHelp size={16} />{error}</div>}<div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>닫기</button><button type="submit" className={`button ${modal.type === 'review' ? 'danger' : 'primary'}`} disabled={busy || (modal.type === 'request' && Boolean(beforeHire)) || (modal.type === 'employee' && (calculationLoading || Boolean(calculationError) || !calculation))}>{busy ? <><span className="spinner" />저장 중…</> : modal.type === 'employee' ? employee ? '수정하기' : '직원 등록' : modal.type === 'request' ? '휴가 등록' : modal.status === 'rejected' ? '반려하기' : '휴가 취소하기'}</button></div></form></div></div>;
}
