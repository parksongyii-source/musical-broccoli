// Standard Korean annual-leave amounts, assuming the required attendance.
// Dates are civil UTC dates; no host timezone or current clock affects the result.
function date(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError(`${label} 형식이 올바르지 않습니다.`);
  }
  const result = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${label}이(가) 올바른 날짜가 아닙니다.`);
  }
  if (result.getUTCFullYear() < 1000 || result.getUTCFullYear() > 9998) {
    throw new RangeError(`${label}의 연도가 올바르지 않습니다.`);
  }
  return result;
}

function iso(value) { return value.toISOString().slice(0, 10); }

// Every anchor comes from the original hire day. A short month does not shift
// subsequent anniversaries (January 31 -> February 28 -> March 31).
function monthAnchor(joined, months) {
  const index = joined.getUTCMonth() + months;
  const year = joined.getUTCFullYear() + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(joined.getUTCDate(), last)));
}

/**
 * Calculate leave earned at asOf from the hire date.
 * First year: one day per completed anchored month, maximum eleven.
 * Subsequent years: fifteen, plus one per two years after the first, up to 25.
 * February 29 anniversaries use February 28 in non-leap years.
 */
export function calculateEntitlement(joinDate, asOf) {
  const joined = date(joinDate, '입사일');
  const at = date(asOf, '조회 기준일');
  if (at < joined) {
    return {
      automaticAllowance: 0,
      completedYears: 0,
      completedMonths: 0,
      calculationBasis: '입사 전 · 발생 연차 0일',
      nextAccrualDate: iso(monthAnchor(joined, 1)),
    };
  }

  let completedYears = at.getUTCFullYear() - joined.getUTCFullYear();
  if (monthAnchor(joined, completedYears * 12) > at) completedYears -= 1;
  let completedMonths = (at.getUTCFullYear() - joined.getUTCFullYear()) * 12
    + at.getUTCMonth() - joined.getUTCMonth();
  if (monthAnchor(joined, completedMonths) > at) completedMonths -= 1;

  if (completedYears === 0) {
    const earned = Math.min(11, completedMonths);
    return {
      automaticAllowance: earned,
      completedYears,
      completedMonths,
      calculationBasis: `1년 미만 · 개근 가정 ${earned}개월 × 1일`,
      nextAccrualDate: iso(monthAnchor(joined, earned + 1)),
    };
  }

  const additional = Math.min(10, Math.floor((completedYears - 1) / 2));
  const automaticAllowance = 15 + additional;
  return {
    automaticAllowance,
    completedYears,
    completedMonths,
    calculationBasis: `근속 ${completedYears}년 · 기본 15일 + 가산 ${additional}일${automaticAllowance === 25 ? ' (상한 25일)' : ''}`,
    nextAccrualDate: iso(monthAnchor(joined, (completedYears + 1) * 12)),
  };
}
