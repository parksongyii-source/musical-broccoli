import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, CircleHelp, ClipboardCheck, History } from 'lucide-react';
import EmployeePicker, { type EmployeeOption } from './EmployeePicker';
import './quickUsedRecord.css';

type LeaveType = 'annual' | 'half_am' | 'half_pm';
type Balance = EmployeeOption & { remainingDays: number; pendingDays: number; usedDays: number; annualAllowance: number; periodStart: string; periodEnd: string };
type Props = {
  employees: readonly EmployeeOption[];
  asOf: string;
  onSaved: (date: string, message: string, employeeId: string) => Promise<void>;
  onHistory: (employeeId: string, month: string) => void;
};
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
const countDays = (start: string, end: string) => {
  const a = new Date(`${start}T00:00:00Z`), b = new Date(`${end}T00:00:00Z`);
  if (!start || !end || !Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime()) || b < a) return 0;
  return Math.floor((b.getTime() - a.getTime()) / 86400000) + 1;
};

export default function QuickUsedRecord({ employees, asOf, onSaved, onHistory }: Props) {
  const [employeeId, setEmployeeId] = useState('');
  const [startDate, setStartDate] = useState(asOf < today ? asOf : today);
  const [endDate, setEndDate] = useState(startDate);
  const [multiple, setMultiple] = useState(false);
  const [type, setType] = useState<LeaveType>('annual');
  const [reason, setReason] = useState('');
  const [showMemo, setShowMemo] = useState(false);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedSignature, setSavedSignature] = useState('');
  const savingRef = useRef(false);
  const employee = employees.find(item => String(item.id) === employeeId);
  const actualEnd = type === 'annual' && multiple ? endDate : startDate;
  const days = type === 'annual' ? countDays(startDate, actualEnd) : 0.5;
  const signature = `${employeeId}|${startDate}|${actualEnd}|${type}`;
  const beforeHire = Boolean(employee && startDate < employee.joinDate);
  const future = startDate > today || actualEnd > today;

  useEffect(() => {
    if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) { setBalance(null); setBalanceLoading(false); return; }
    const controller = new AbortController();
    setBalanceLoading(true); setBalance(null);
    void fetch(`/api/bootstrap?asOf=${encodeURIComponent(startDate)}`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(data => { if (!controller.signal.aborted) setBalance(data.employees.find((item: Balance) => String(item.id) === employeeId) ?? null); })
      .catch(() => { if (!controller.signal.aborted) setBalance(null); })
      .finally(() => { if (!controller.signal.aborted) setBalanceLoading(false); });
    return () => controller.abort();
  }, [employeeId, startDate, employees]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current || !employee || !days) return;
    setError('');
    if (future) { setError('이미 사용한 연차만 기록합니다. 오늘 또는 이전 날짜를 선택해 주세요.'); return; }
    if (beforeHire) { setError('입사일 이후의 사용 날짜를 선택해 주세요.'); return; }
    savingRef.current = true; setSaving(true);
    try {
      const response = await fetch('/api/requests/record-used', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: Number(employeeId), startDate, endDate: actualEnd, type, reason }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || '사용 기록을 저장하지 못했습니다. 다시 확인해 주세요.');
      setSavedSignature(signature);
      await onSaved(startDate, `${employee.name} · ${startDate.replaceAll('-', '.')} · ${body.days}일 사용을 기록했습니다.`, employeeId);
    } catch (caught) { setError((caught as Error).message); }
    finally { savingRef.current = false; setSaving(false); }
  }

  return <section className="panel quick-used-panel" aria-labelledby="quick-used-title">
    <div className="quick-used-heading"><span className="quick-used-mark"><ClipboardCheck size={22} /></span><div><h2 id="quick-used-title">연차 사용 기록</h2><p>이름을 찾고, 사용한 날짜를 고른 뒤 저장하세요.</p></div><span className="quick-used-tag">저장 즉시 차감</span></div>
    {employees.length ? <form onSubmit={event => void submit(event)}>
      <div className="quick-used-fields">
        <EmployeePicker employees={employees} value={employeeId} onChange={id => { setEmployeeId(id); setError(''); }} disabled={saving} label="사용 직원 이름" inputId="quick-used-employee" />
        <label className="form-field">사용한 날짜<input className="form-input" aria-label="사용한 날짜" type="date" value={startDate} min={employee?.joinDate} max={today} required disabled={saving} onChange={event => { setStartDate(event.target.value); if (endDate < event.target.value) setEndDate(event.target.value); setError(''); }} /></label>
        <label className="form-field">사용 종류<select className="form-input" aria-label="사용 종류" value={type} disabled={saving} onChange={event => { setType(event.target.value as LeaveType); setError(''); }}><option value="annual">연차 · 1일</option><option value="half_am">오전 반차 · 0.5일</option><option value="half_pm">오후 반차 · 0.5일</option></select></label>
        <button className="button primary quick-used-save" type="submit" disabled={saving || !employee || !startDate || !days || future || beforeHire || signature === savedSignature}>{saving ? <span className="spinner" /> : <Check size={17} />}{signature === savedSignature ? '기록 완료' : '사용 기록 저장'}</button>
      </div>
      <div className="quick-used-options">{type === 'annual' && <label><input type="checkbox" checked={multiple} disabled={saving} onChange={event => { setMultiple(event.target.checked); if (endDate < startDate) setEndDate(startDate); setError(''); }} />여러 날 기록</label>}<button type="button" disabled={saving} onClick={() => setShowMemo(value => !value)}>{showMemo ? '메모 접기' : '메모 추가'}</button>{employee && <button type="button" disabled={saving} onClick={() => onHistory(employeeId, /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate.slice(0, 7) : asOf.slice(0, 7))}><History size={14} />이 직원 월별 내역</button>}</div>
      {type === 'annual' && multiple && <label className="form-field quick-used-extra">마지막 사용 날짜<input className="form-input" aria-label="마지막 사용 날짜" type="date" required min={startDate} max={today} value={endDate} disabled={saving} onChange={event => { setEndDate(event.target.value); setError(''); }} /><small>선택한 시작일부터 마지막 날까지 모두 사용일로 계산합니다.</small></label>}
      {showMemo && <label className="form-field quick-used-extra">메모 (선택)<input className="form-input" maxLength={500} value={reason} disabled={saving} onChange={event => setReason(event.target.value)} placeholder="필요한 내용만 간단히 적어 주세요." /></label>}
      {employee && <div className="quick-used-selection"><strong>{employee.name}</strong><span>{employee.department} · 입사 {employee.joinDate.replaceAll('-', '.')}</span><span className="quick-used-balance">{balanceLoading ? '잔여 연차 확인 중…' : balance ? `기록일 발생 ${balance.annualAllowance}일 · 이 기간 등록 사용 ${balance.usedDays}일` : '잔여 연차는 저장할 때 다시 확인합니다.'}</span><span className="quick-used-deduction">이번 기록 {days}일</span></div>}
      {error && <div className="form-error" role="alert"><CircleHelp size={16} />{error}</div>}
      {beforeHire && <p className="quick-used-alert">입사일 이후의 사용 날짜를 선택해 주세요.</p>}
      {future && <p className="quick-used-alert">사용한 연차는 오늘까지의 날짜로 기록합니다. 미래 휴가는 ‘휴가 등록’을 사용하세요.</p>}
      {signature === savedSignature && <p className="quick-used-success" role="status">사용 기록이 저장됐습니다. 다른 날짜나 직원을 선택하면 이어서 기록할 수 있습니다.</p>}
      <p className="quick-used-policy"><CircleHelp size={13} />주말·공휴일에도 사용할 수 있습니다. 실제 근무하는 날짜를 선택해 주세요.</p>
    </form> : <div className="quick-used-empty">직원을 먼저 등록하면 이름을 검색해 바로 사용 기록을 남길 수 있습니다.</div>}
  </section>;
}
