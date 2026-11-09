import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import { searchEmployees, type EmployeeSearchRecord } from './employeeSearch';
import './employeePicker.css';

export type EmployeeOption = EmployeeSearchRecord & { remainingDays?: number };

type EmployeePickerProps = {
  employees: readonly EmployeeOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  label?: string;
  inputId?: string;
};

export default function EmployeePicker({ employees, value, onChange, disabled = false, label = '직원 이름', inputId }: EmployeePickerProps) {
  const generatedId = useId().replaceAll(':', '');
  const id = inputId || `employee-picker-${generatedId}`;
  const listId = `${id}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedEmployee = employees.find((employee) => String(employee.id) === value);
  const [query, setQuery] = useState(selectedEmployee?.name || '');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const previousValue = useRef(value);
  const clearedByTyping = useRef(false);
  const results = searchEmployees(employees, query);
  const activeEmployee = open ? results[activeIndex] : undefined;
  const optionId = (employeeId: string | number) => `${listId}-option-${encodeURIComponent(String(employeeId))}`;

  useEffect(() => {
    if (value) {
      setQuery(selectedEmployee?.name || '');
      clearedByTyping.current = false;
    } else if (previousValue.current && !clearedByTyping.current) {
      setQuery('');
    }
    previousValue.current = value;
    clearedByTyping.current = false;
  }, [value, selectedEmployee?.name]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(activeEmployee ? optionId(activeEmployee.id) : '')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, activeEmployee?.id, open]);

  function choose(employee: EmployeeOption) {
    setQuery(employee.name);
    onChange(String(employee.id));
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => {
        if (!results.length) return -1;
        if (!open || index < 0) return event.key === 'ArrowDown' ? 0 : results.length - 1;
        return (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      });
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      if (activeEmployee) choose(activeEmployee);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  return <div className={`employee-picker${disabled ? ' is-disabled' : ''}`}>
    <label className="employee-picker-label" htmlFor={id}>{label}</label>
    <div className="employee-picker-input-wrap">
      <Search className="employee-picker-search-icon" size={17} aria-hidden="true" />
      <input
        ref={inputRef}
        id={id}
        className="employee-picker-input"
        type="text"
        role="combobox"
        value={query}
        placeholder="직원 이름 검색"
        autoComplete="off"
        disabled={disabled}
        aria-autocomplete="list"
        aria-expanded={open && !disabled}
        aria-controls={listId}
        aria-activedescendant={activeEmployee ? optionId(activeEmployee.id) : undefined}
        onFocus={() => { setOpen(true); setActiveIndex(-1); }}
        onBlur={() => { setOpen(false); setActiveIndex(-1); }}
        onKeyDown={onKeyDown}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActiveIndex(-1);
          if (value) {
            clearedByTyping.current = true;
            onChange('');
          }
        }}
      />
      {query && !disabled && <button
        className="employee-picker-clear"
        type="button"
        aria-label="직원 검색 지우기"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => { setQuery(''); onChange(''); setOpen(true); setActiveIndex(-1); inputRef.current?.focus(); }}
      ><X size={15} /></button>}
    </div>
    {open && !disabled && <div className="employee-picker-dropdown">
      <ul className="employee-picker-list" id={listId} role="listbox" aria-label={label}>
        {results.map((employee, index) => <li
          id={optionId(employee.id)}
          key={employee.id}
          role="option"
          aria-selected={String(employee.id) === value}
          className={`employee-picker-option${index === activeIndex ? ' is-active' : ''}${String(employee.id) === value ? ' is-selected' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => setActiveIndex(index)}
          onClick={() => choose(employee)}
        >
          <span className="employee-picker-name">{employee.name}</span>
          <span className="employee-picker-details">{employee.department || '부서 미지정'} · 입사 {employee.joinDate.replaceAll('-', '.')}</span>
        </li>)}
      </ul>
      {!results.length && <p className="employee-picker-empty">검색 결과가 없습니다. 이름이나 부서를 확인해 주세요.</p>}
    </div>}
  </div>;
}
