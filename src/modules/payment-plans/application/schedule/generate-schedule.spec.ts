import { generateSchedule } from './generate-schedule';

describe('generateSchedule', () => {
  const base = {
    totalToFinance: 1200,
    downPayment: 0,
    installmentsCount: 12,
    periodicity: 'MONTHLY' as const,
    startDate: new Date('2026-01-15T00:00:00.000Z'),
  };

  it('divides financed amount into N equal installments', () => {
    const rows = generateSchedule(base);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.amount === 100)).toBe(true);
    expect(rows.map((r) => r.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it('subtracts the down payment before dividing', () => {
    const rows = generateSchedule({ ...base, downPayment: 200 });
    // (1200 - 200) / 12 -> last row absorbs the cent remainder
    const sum = rows.reduce((s, r) => s + r.amount, 0);
    expect(Math.round(sum * 100) / 100).toBe(1000);
  });

  it('puts the rounding remainder on the LAST installment', () => {
    const rows = generateSchedule({
      ...base,
      totalToFinance: 100,
      installmentsCount: 3,
    });
    // 100 / 3 -> 33.33, 33.33, 33.34
    expect(rows.map((r) => r.amount)).toEqual([33.33, 33.33, 33.34]);
    const sum = rows.reduce((s, r) => s + r.amount, 0);
    expect(Math.round(sum * 100) / 100).toBe(100);
  });

  it('spaces MONTHLY installments one calendar month apart from startDate', () => {
    const rows = generateSchedule({ ...base, installmentsCount: 3 });
    expect(rows.map((r) => r.dueDate.toISOString().slice(0, 10))).toEqual([
      '2026-01-15',
      '2026-02-15',
      '2026-03-15',
    ]);
  });

  it('clamps month-end overflow (Jan 31 + 1 month -> Feb 28)', () => {
    const rows = generateSchedule({
      ...base,
      installmentsCount: 2,
      startDate: new Date('2026-01-31T00:00:00.000Z'),
    });
    expect(rows.map((r) => r.dueDate.toISOString().slice(0, 10))).toEqual([
      '2026-01-31',
      '2026-02-28',
    ]);
  });

  it('spaces WEEKLY installments 7 days apart', () => {
    const rows = generateSchedule({
      ...base,
      periodicity: 'WEEKLY',
      installmentsCount: 3,
    });
    expect(rows.map((r) => r.dueDate.toISOString().slice(0, 10))).toEqual([
      '2026-01-15',
      '2026-01-22',
      '2026-01-29',
    ]);
  });

  it('spaces BIWEEKLY installments 14 days apart', () => {
    const rows = generateSchedule({
      ...base,
      periodicity: 'BIWEEKLY',
      installmentsCount: 2,
    });
    expect(rows.map((r) => r.dueDate.toISOString().slice(0, 10))).toEqual([
      '2026-01-15',
      '2026-01-29',
    ]);
  });

  it('sum of installments is bit-exact to financedAmount in cents (no float drift)', () => {
    // NOTE: comparing the raw dollar-float sum (rows.reduce((s,r)=>s+r.amount,0)) against
    // 1000 with strict `toBe` is NOT achievable here even with a correct integer-cent
    // split: 83.33 (x11) + 83.37 summed left-to-right via Array.reduce is IEEE-754
    // 1000.0000000000001, not 1000, because 83.33/83.37 are not exactly representable in
    // binary floating point. That is a property of double summation order, not a bug in
    // the split. The invariant the review cares about -- Sigma installments === financed
    // EXACTLY -- is genuinely bit-exact at the correct granularity: integer cents.
    const rows = generateSchedule({
      ...base,
      totalToFinance: 1200,
      downPayment: 200,
      installmentsCount: 12,
    });
    const sumCents = rows.reduce((s, r) => s + Math.round(r.amount * 100), 0);
    expect(sumCents).toBe(100000); // strict ===, exact in integer cents by construction
  });
});
