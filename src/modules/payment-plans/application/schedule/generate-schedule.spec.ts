import fc from 'fast-check';
import { generateSchedule } from './generate-schedule';
import { deriveStatuses } from './derive-statuses';
import { round2, toCents } from '../../../../shared/money/money';
import type { RoundingDigits } from '../../../../shared/money/line-rounding';

describe('generateSchedule', () => {
  const base = {
    totalToFinance: 1200,
    downPayment: 0,
    installmentsCount: 12,
    periodicity: 'MONTHLY' as const,
    startDate: new Date('2026-01-15T00:00:00.000Z'),
    roundingDigits: 2 as RoundingDigits,
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
    expect(round2(sum)).toBe(1000);
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
    expect(round2(sum)).toBe(100);
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
    const sumCents = rows.reduce((s, r) => s + toCents(r.amount), 0);
    expect(sumCents).toBe(100000); // strict ===, exact in integer cents by construction
  });

  describe('DX-488: cuotas en unidades de los dígitos de redondeo de la moneda', () => {
    const jpy = { ...base, roundingDigits: 0 as RoundingDigits };
    const amounts = (rows: { amount: number }[]) => rows.map((r) => r.amount);

    it('JPY 10000 en 3: 3333, 3333 y 3334 (sin céntimos)', () => {
      expect(
        amounts(
          generateSchedule({
            ...jpy,
            totalToFinance: 10000,
            installmentsCount: 3,
          }),
        ),
      ).toEqual([3333, 3333, 3334]);
    });

    it('JPY 100000 en 7: seis de 14285 y la última de 14290', () => {
      expect(
        amounts(
          generateSchedule({
            ...jpy,
            totalToFinance: 100000,
            installmentsCount: 7,
          }),
        ),
      ).toEqual([14285, 14285, 14285, 14285, 14285, 14285, 14290]);
    });

    it('JPY 50000 con pie de 10000 en 12: once de 3333 y la última de 3337', () => {
      const rows = generateSchedule({
        ...jpy,
        totalToFinance: 50000,
        downPayment: 10000,
        installmentsCount: 12,
      });
      expect(amounts(rows)).toEqual([...Array<number>(11).fill(3333), 3337]);
    });

    it('los céntimos sueltos del financiado van a la última: JPY 10000.50 en 3', () => {
      expect(
        amounts(
          generateSchedule({
            ...jpy,
            totalToFinance: 10000.5,
            installmentsCount: 3,
          }),
        ),
      ).toEqual([3333, 3333, 3334.5]);
    });

    it('menos unidades que cuotas: JPY 2 en 3 da 0, 0 y 2', () => {
      expect(
        amounts(
          generateSchedule({ ...jpy, totalToFinance: 2, installmentsCount: 3 }),
        ),
      ).toEqual([0, 0, 2]);
    });

    it('1 decimal: unidades de 10 céntimos', () => {
      expect(
        amounts(
          generateSchedule({
            ...base,
            roundingDigits: 1,
            totalToFinance: 100,
            installmentsCount: 3,
          }),
        ),
      ).toEqual([33.3, 33.3, 33.4]);
    });

    it('USD y VES (2 decimales) no cambian: 100 en 3 sigue en 33.33, 33.33, 33.34', () => {
      for (const currencyDigits of [2] as const) {
        expect(
          amounts(
            generateSchedule({
              ...base,
              roundingDigits: currencyDigits,
              totalToFinance: 100,
              installmentsCount: 3,
            }),
          ),
        ).toEqual([33.33, 33.33, 33.34]);
      }
    });

    it('estado: dos pagos de ¥3333 dejan PAGADAS las cuotas 1 y 2 de 3333/3333/3334', () => {
      const rows = generateSchedule({
        ...jpy,
        totalToFinance: 10000,
        installmentsCount: 3,
        startDate: new Date('2026-01-15T00:00:00.000Z'),
      });
      const out = deriveStatuses(
        rows.map((r) => ({ kind: 'INSTALLMENT' as const, ...r })),
        3333 + 3333,
        new Date('2026-04-01T00:00:00.000Z'),
        { roundingDigits: 0 },
      );
      expect(out.map((t) => [t.amount, t.covered, t.status])).toEqual([
        [3333, 3333, 'PAID'],
        [3333, 3333, 'PAID'],
        [3334, 0, 'OVERDUE'],
      ]);
    });

    /** El reparto de antes de DX-488 (al céntimo para toda moneda). */
    function centsSplit(financedCents: number, n: number): number[] {
      const baseCents = Math.floor(financedCents / n);
      return Array.from({ length: n }, (_, i) =>
        i === n - 1 ? financedCents - baseCents * (n - 1) : baseCents,
      );
    }

    const cases = fc.record({
      financedCents: fc.integer({ min: 0, max: 10_000_000 }),
      downCents: fc.integer({ min: 0, max: 1_000_000 }),
      n: fc.integer({ min: 1, max: 600 }),
    });

    it('propiedad: con 2 decimales el resultado es el de antes, céntimo a céntimo', () => {
      fc.assert(
        fc.property(cases, ({ financedCents, downCents, n }) => {
          const rows = generateSchedule({
            ...base,
            totalToFinance: (financedCents + downCents) / 100,
            downPayment: downCents / 100,
            installmentsCount: n,
          });
          expect(rows.map((r) => toCents(r.amount))).toEqual(
            centsSplit(financedCents, n),
          );
        }),
        { numRuns: 500 },
      );
    });

    it('propiedad: para 0, 1 y 2 decimales la suma es exacta, nada es negativo y las cuotas 1..n−1 son unidades enteras', () => {
      fc.assert(
        fc.property(
          cases,
          fc.constantFrom<RoundingDigits>(0, 1, 2),
          ({ financedCents, downCents, n }, digits) => {
            const unit = 10 ** (2 - digits);
            const rows = generateSchedule({
              ...base,
              roundingDigits: digits,
              totalToFinance: (financedCents + downCents) / 100,
              downPayment: downCents / 100,
              installmentsCount: n,
            });
            const cents = rows.map((r) => toCents(r.amount));
            expect(rows).toHaveLength(n);
            expect(cents.reduce((s, c) => s + c, 0)).toBe(financedCents);
            expect(cents.every((c) => c >= 0)).toBe(true);
            expect(cents.slice(0, -1).every((c) => c % unit === 0)).toBe(true);
            // La última solo se lleva el resto: menos de n unidades de más.
            expect(cents[n - 1] - cents[0]).toBeLessThan(n * unit);
          },
        ),
        { numRuns: 1000 },
      );
    });
  });
});
