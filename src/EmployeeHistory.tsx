import { CalendarDays, History } from 'lucide-react';
import type { EmployeeOption } from './EmployeePicker';
import MonthlyHistory from './MonthlyHistory';
import PeriodHistory from './PeriodHistory';
import './periodHistory.css';

export type HistoryMode = 'period' | 'month';
type Props = {
  employees: readonly EmployeeOption[];
  employeeId: string;
  onEmployeeChange: (id: string) => void;
  mode: HistoryMode;
  onModeChange: (mode: HistoryMode) => void;
  asOf: string;
  onAsOfChange: (asOf: string) => void;
  month: string;
  onMonthChange: (month: string) => void;
  refreshKey?: number;
};

export default function EmployeeHistory({ mode, onModeChange, asOf, onAsOfChange, ...props }: Props) {
  return <div className="employee-history">
    <div className="history-view-tabs" role="group" aria-label="사용내역 보기 방식">
      <button className={mode === 'period' ? 'active' : ''} aria-pressed={mode === 'period'} onClick={() => onModeChange('period')}><History size={17} />연차기간 전체 보기</button>
      <button className={mode === 'month' ? 'active' : ''} aria-pressed={mode === 'month'} onClick={() => onModeChange('month')}><CalendarDays size={17} />월별 보기</button>
    </div>
    {mode === 'period'
      ? <PeriodHistory employees={props.employees} employeeId={props.employeeId} onEmployeeChange={props.onEmployeeChange} asOf={asOf} onAsOfChange={onAsOfChange} refreshKey={props.refreshKey} />
      : <MonthlyHistory {...props} />}
  </div>;
}
