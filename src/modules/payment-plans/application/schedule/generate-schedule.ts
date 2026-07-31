export type Periodicity = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';

export interface GenerateScheduleInput {
  totalToFinance: number;
  downPayment: number;
  installmentsCount: number;
  periodicity: Periodicity;
  startDate: Date;
}

export interface GeneratedInstallment {
  sequence: number;
  dueDate: Date;
  amount: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Truncate to 2 decimals toward zero, so the per-installment base never
// overshoots and the last installment always absorbs a NON-NEGATIVE remainder.
function floor2(value: number): number {
  return Math.floor(value * 100) / 100;
}

// Calendar-month add in UTC with end-of-month clamp (Jan 31 + 1m -> Feb 28/29),
// so a due date never rolls over into the next month.
function addMonthsUtc(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const target = new Date(Date.UTC(y, m + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  target.setUTCHours(
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  );
  return target;
}

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function dueDateFor(
  startDate: Date,
  periodicity: Periodicity,
  index: number, // 0-based
): Date {
  switch (periodicity) {
    case 'WEEKLY':
      return addDaysUtc(startDate, 7 * index);
    case 'BIWEEKLY':
      return addDaysUtc(startDate, 14 * index);
    case 'MONTHLY':
      return addMonthsUtc(startDate, index);
  }
}

export function generateSchedule(
  input: GenerateScheduleInput,
): GeneratedInstallment[] {
  const { installmentsCount, periodicity, startDate } = input;
  const financed = round2(input.totalToFinance - input.downPayment);
  const base = floor2(financed / installmentsCount);

  const rows: GeneratedInstallment[] = [];
  for (let i = 0; i < installmentsCount; i++) {
    const isLast = i === installmentsCount - 1;
    const amount = isLast
      ? round2(financed - base * (installmentsCount - 1))
      : base;
    rows.push({
      sequence: i + 1,
      dueDate: dueDateFor(startDate, periodicity, i),
      amount,
    });
  }
  return rows;
}
