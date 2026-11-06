import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, ClipboardPaste, Download, FileUp, Trash2, UsersRound, X } from 'lucide-react';
import { decodeEmployeeFile, parseEmployeeText, templateCSV, type ImportEmployee, type ParsedEmployee } from './importEmployees';

type Draft = ParsedEmployee & { id: number };
type PreviewRow = {
  rowNumber: number;
  employee: ImportEmployee;
  status: 'ready' | 'duplicate' | 'invalid';
  errors: string[];
  automaticAllowance: number | null;
  calculationBasis?: string;
  periodStart?: string;
  periodEnd?: string;
};
type Preview = {
  asOf: string;
  rows: PreviewRow[];
  summary: { total: number; ready: number; duplicate: number; invalid: number };
  canImport: boolean;
};
type Props = { asOf: string; onClose: () => void; onImported: (count: number) => Promise<void> };

const columns: { field: keyof ImportEmployee; label: string }[] = [
  { field: 'name', label: '이름' },
  { field: 'department', label: '부서' },
  { field: 'position', label: '직책' },
  { field: 'joinDate', label: '입사일' },
];
const labels = { ready: '등록 가능', duplicate: '중복', invalid: '확인 필요' };

function isPreview(value: unknown): value is Preview {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Preview>;
  return Array.isArray(candidate.rows) && Boolean(candidate.summary) && typeof candidate.canImport === 'boolean' && typeof candidate.asOf === 'string';
}

function serialize(drafts: Draft[]) {
  const quote = (value: string) => /[\t\n\r"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return ['이름\t부서\t직책\t입사일', ...drafts.map(draft => columns.map(column => quote(draft.employee[column.field])).join('\t'))].join('\n');
}

export default function BulkImport({ asOf, onClose, onImported }: Props) {
  const [text, setText] = useState('');
  const [filename, setFilename] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [step, setStep] = useState<'input' | 'review'>('input');
  const [error, setError] = useState('');
  const [operation, setOperation] = useState<'idle' | 'review' | 'import' | 'file'>('idle');
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const closeRef = useRef(onClose);
  const nextId = useRef(1);
  const ticket = useRef(0);
  const currentAsOf = useRef(asOf);
  const busy = operation !== 'idle';
  busyRef.current = busy;
  closeRef.current = onClose;
  currentAsOf.current = asOf;

  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busyRef.current) closeRef.current();
      if (event.key !== 'Tab') return;
      const focusable = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]');
      if (!focusable?.length) { event.preventDefault(); return; }
      const items = [...focusable].filter(item => item.getClientRects().length > 0);
      const first = items[0], last = items[items.length - 1];
      if (!items.length) { event.preventDefault(); return; }
      if (!dialog.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      ticket.current += 1;
      document.body.style.overflow = oldOverflow;
      document.removeEventListener('keydown', onKey);
      returnFocus?.focus();
    };
  }, []);

  useEffect(() => { setPreview(null); }, [asOf]);

  async function requestPreview(rows: Draft[]) {
    const current = ++ticket.current;
    setPreview(null);
    setError('');
    if (!rows.length) { setError('등록할 직원을 한 명 이상 입력해 주세요.'); return; }
    setOperation('review');
    try {
      const response = await fetch('/api/employees/import-preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employees: rows.map(row => row.employee), asOf }),
      });
      const body = await response.json().catch(() => null);
      if (current !== ticket.current || currentAsOf.current !== asOf) return;
      if (!response.ok) throw new Error(body?.error || '직원 정보를 검토하지 못했습니다. 다시 시도해 주세요.');
      if (!isPreview(body) || body.rows.length !== rows.length) throw new Error('검토 결과를 확인하지 못했습니다. 다시 시도해 주세요.');
      setPreview(body);
    } catch (caught) {
      if (current === ticket.current) setError((caught as Error).message);
    } finally { if (current === ticket.current) setOperation('idle'); }
  }

  function inspectText() {
    setError('');
    try {
      const parsed = parseEmployeeText(text);
      const rows = parsed.map(row => ({ ...row, id: nextId.current++ }));
      setDrafts(rows);
      setStep('review');
      void requestPreview(rows);
    } catch (caught) { setError((caught as Error).message); }
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    setError('');
    if (!/\.(csv|tsv|txt)$/i.test(file.name)) {
      setError('CSV 파일을 선택해 주세요. 엑셀(.xlsx)은 셀을 복사해 붙여넣거나 CSV로 저장해 주세요.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) { setError('파일 크기는 2MB 이하로 선택해 주세요. 한 번에 최대 500명까지 등록할 수 있습니다.'); return; }
    setOperation('file');
    const current = ++ticket.current;
    try {
      const content = decodeEmployeeFile(await file.arrayBuffer());
      if (current !== ticket.current) return;
      setText(content); setFilename(file.name); setPreview(null); setDrafts([]); setStep('input');
    } catch (caught) { if (current === ticket.current) setError((caught as Error).message || '파일 내용을 읽지 못했습니다.'); }
    finally { if (current === ticket.current) setOperation('idle'); }
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([templateCSV], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url; link.download = '온휴_직원등록_양식.csv'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function editRow(id: number, field: keyof ImportEmployee, value: string) {
    setDrafts(current => current.map(row => row.id === id ? { ...row, employee: { ...row.employee, [field]: value } } : row));
    setPreview(null); setError('');
  }

  function removeRow(id: number) {
    setDrafts(current => current.filter(row => row.id !== id));
    setPreview(null); setError('');
  }

  function removeDuplicates() {
    if (!preview) return;
    const next = drafts.filter((_draft, index) => preview.rows[index]?.status !== 'duplicate');
    setDrafts(next);
    void requestPreview(next);
  }

  async function importEmployees() {
    if (!preview?.canImport || preview.asOf !== asOf || preview.summary.ready !== drafts.length || !drafts.length || busy) return;
    setError(''); setOperation('import');
    try {
      const response = await fetch('/api/employees/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employees: drafts.map(row => row.employee), asOf }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (isPreview(body) && body.rows.length === drafts.length) setPreview(body);
        else setPreview(null);
        throw new Error(body?.error || '직원을 등록하지 못했습니다. 다시 검토해 주세요.');
      }
      if (!Number.isInteger(body?.imported) || body.imported !== drafts.length) {
        setPreview(null);
        throw new Error('등록 결과를 확인하지 못했습니다. 창을 닫고 직원 목록을 확인해 주세요.');
      }
      await onImported(body.imported);
    } catch (caught) { setError((caught as Error).message); }
    finally { setOperation('idle'); }
  }

  return <div className="modal-backdrop bulk-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="modal bulk-modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="bulk-title">
      <div className="modal-header bulk-header">
        <div><span className="eyebrow">ONHYU WORKSPACE</span><h2 id="bulk-title">직원 일괄 등록</h2><p>엑셀 명단을 한 번에 가져오고, 연차는 자동으로 계산하세요.</p></div>
        <button className="icon-button modal-close" ref={closeButton} aria-label="일괄 등록 창 닫기" disabled={busy} onClick={onClose}><X size={21} /></button>
      </div>
      <div className="bulk-steps" aria-label="등록 순서"><span className={step === 'input' ? 'active' : 'complete'}><b>{step === 'input' ? '1' : <Check size={13} />}</b>명단 입력</span><i /><span className={step === 'review' ? 'active' : ''}><b>2</b>검토 후 등록</span></div>
      <div className="bulk-body">
        {step === 'input' ? <>
          <div className="bulk-tools"><button className="button secondary small" onClick={downloadTemplate}><Download size={15} />CSV 양식 다운로드</button><label className={`button secondary small bulk-file-button ${busy ? 'disabled' : ''}`}><FileUp size={15} />CSV 파일 선택<input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" aria-label="직원 CSV 파일 선택" disabled={busy} onChange={event => { void readFile(event.target.files?.[0]); event.target.value = ''; }} /></label>{filename && <span className="bulk-filename">{filename}</span>}</div>
          <label className="form-field bulk-paste-label"><span><ClipboardPaste size={17} />엑셀에서 붙여넣기</span><textarea className="form-input bulk-paste" aria-label="엑셀 직원 명단 붙여넣기" value={text} disabled={busy} onChange={event => { setText(event.target.value); setFilename(''); setPreview(null); }} placeholder={'이름\t부서\t직책\t입사일\n김온유\t경영지원팀\t매니저\t2023-07-12\n이휴식\t개발팀\t선임\t2024-03-04'} /></label>
          <div className="bulk-instructions"><strong>엑셀에서 표를 선택해 복사한 뒤 위 칸에 붙여넣으세요.</strong><p>이름과 입사일은 필수입니다. 부서를 비우면 ‘미지정’으로 등록됩니다. 머리글이 있으면 열 순서를 자동으로 인식합니다.</p><p>머리글 없이 붙여넣을 때: <b>이름 · 입사일</b> / <b>이름 · 부서 · 입사일</b> / <b>이름 · 부서 · 직책 · 입사일</b></p><p>입사일 예: 2023-07-12, 2023.7.12, 2023/7/12. 최대 500명 · CSV 2MB 이하.</p><small>빈 CSV 양식에 직원 명단을 입력해 가져올 수도 있습니다. 검토하기만으로는 등록되지 않습니다.</small></div>
        </> : <>
          <div className="bulk-review-heading"><div><h3><UsersRound size={18} />총 {drafts.length}명 검토</h3><p>필요한 내용을 표에서 바로 수정하세요. 수정 후에는 다시 검토해야 등록할 수 있습니다.</p></div><button className="button subtle small" disabled={busy} onClick={() => { setText(serialize(drafts)); setStep('input'); setPreview(null); setError(''); }}>명단 다시 붙여넣기</button></div>
          <div className="bulk-summary" aria-live="polite"><span className="ready">등록 가능 <b>{preview?.summary.ready ?? '—'}</b></span><span className="duplicate">중복 <b>{preview?.summary.duplicate ?? '—'}</b></span><span className="invalid">확인 필요 <b>{preview?.summary.invalid ?? '—'}</b></span>{preview && preview.summary.duplicate > 0 && <button disabled={busy} onClick={removeDuplicates}>중복 {preview.summary.duplicate}행 제외</button>}</div>
          {!preview && operation !== 'review' && <p className="bulk-recheck-note" role="status">내용이 변경되었습니다. ‘다시 검토’를 눌러 확인해 주세요.</p>}
          <div className="bulk-table-wrap"><table className="bulk-table"><thead><tr><th>원본 행</th>{columns.map(column => <th key={column.field}>{column.label}{['name', 'joinDate'].includes(column.field) && <span aria-hidden="true"> *</span>}</th>)}<th>자동 연차</th><th>검토 결과</th><th>삭제</th></tr></thead><tbody>{drafts.map((draft, index) => {
            const row = preview?.rows[index];
            return <tr key={draft.id} className={row && row.status !== 'ready' ? `bulk-row-${row.status}` : ''} data-source-row={draft.sourceRow}><td className="bulk-row-number">{draft.sourceRow}</td>{columns.map(column => <td key={column.field}><input aria-label={`${draft.sourceRow}행 ${column.label}`} value={draft.employee[column.field]} disabled={busy} maxLength={column.field === 'name' ? 100 : column.field === 'joinDate' ? 40 : 120} onChange={event => editRow(draft.id, column.field, event.target.value)} placeholder={column.field === 'department' ? '미지정' : column.field === 'joinDate' ? 'YYYY-MM-DD' : ''} /></td>)}<td className="bulk-days">{row && typeof row.automaticAllowance === 'number' ? `${row.automaticAllowance}일` : '—'}</td><td className="bulk-result">{row ? <><span className={`bulk-status ${row.status}`}>{labels[row.status]}</span>{row.errors?.map((message, i) => <small key={i}>{message}</small>)}</> : <span className="muted">검토 필요</span>}</td><td><button className="icon-button" aria-label={`${draft.sourceRow}행 삭제`} disabled={busy} onClick={() => removeRow(draft.id)}><Trash2 size={15} /></button></td></tr>;
          })}</tbody></table>{!drafts.length && <div className="empty-state">등록할 행이 없습니다. 명단을 다시 붙여넣어 주세요.</div>}</div>
          <p className="bulk-safety-note"><AlertCircle size={14} />중복 또는 오류가 있으면 전체가 등록되지 않습니다. 기존 직원·휴가 기록은 변경하지 않습니다.</p>
        </>}
        {error && <div className="form-error bulk-error" role="alert"><AlertCircle size={16} />{error}</div>}
      </div>
      <div className="modal-actions bulk-actions"><span>{operation === 'review' ? '직원 정보와 연차를 검토하고 있습니다.' : operation === 'file' ? '파일을 읽고 있습니다.' : operation === 'import' ? '직원 정보를 등록하고 있습니다.' : `연차 조회 기준일 ${asOf}`}</span><button className="button secondary" disabled={busy} onClick={onClose}>닫기</button>{step === 'input' ? <button className="button primary" disabled={busy || !text.trim()} onClick={inspectText}>{operation === 'review' ? <span className="spinner" /> : <Check size={16} />}검토하기</button> : <><button className="button secondary" disabled={busy || !drafts.length} onClick={() => void requestPreview(drafts)}>{operation === 'review' && <span className="spinner" />}다시 검토</button><button className="button primary" disabled={busy || !preview?.canImport || preview.asOf !== asOf || preview.summary.ready !== drafts.length || !drafts.length} onClick={() => void importEmployees()}>{operation === 'import' ? <span className="spinner" /> : <UsersRound size={16} />}{drafts.length}명 등록</button></>}</div>
    </div>
  </div>;
}
