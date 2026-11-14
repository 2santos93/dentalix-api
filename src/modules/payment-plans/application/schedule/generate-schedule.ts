import { round2, toCents } from '../../../../shared/money/money';
import {
  type RoundingDigits,
  unitCents,
} from '../../../../shared/money/line-rounding';
export type Periodicity = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';

export interface GenerateScheduleInput {
  totalToFinance: number;
  downPayment: number;
  installmentsCount: number;
  periodicity: Periodicity;
  startDate: Date;
  /**
   * Dígitos de redondeo de la moneda del plan (`currencies.rounding_digits`,
   * DX-488): las cuotas se reparten en unidades de esa moneda.
   */
  roundingDigits: RoundingDigits;
}

export interface GeneratedInstallment {
  sequence: number;
  dueDate: Date;
  amount: number;
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

  // Do the per-installment split in INTEGER CENTS so the sum is bit-exact
  // by construction (float division/rounding would otherwise drift, e.g.
  // 0.1 + 0.2 !== 0.3). DX-488: the first N-1 installments get the floored
  // base in whole units of the currency's rounding digits (1, 10 or 100
  // cents: JPY 10000 / 3 -> 3333, 3333, 3334); the last absorbs whatever
  // remains, loose cents of the financed amount included, which is always
  // >= 0. With 2 rounding digits the unit is 1 cent: the same split as before.
  // Existing plans are never re-split: installments are stored rows.
  const financedCents = toCents(financed);
  const unit = unitCents(input.roundingDigits);
  const baseCents = Number(
    (BigInt(financedCents) / unit / BigInt(installmentsCount)) * unit,
  );

  const rows: GeneratedInstallment[] = [];
  for (let i = 0; i < installmentsCount; i++) {
    const isLast = i === installmentsCount - 1;
    const amountCents = isLast
      ? financedCents - baseCents * (installmentsCount - 1)
      : baseCents;
    rows.push({
      sequence: i + 1,
      dueDate: dueDateFor(startDate, periodicity, i),
      amount: amountCents / 100,
    });
  }
  return rows;
}
