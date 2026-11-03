import { deriveStatuses, ScheduleTramo } from './derive-statuses';

const today = new Date('2026-03-01T00:00:00.000Z');

function inst(seq: number, iso: string, amount: number): ScheduleTramo {
  return { kind: 'INSTALLMENT', sequence: seq, dueDate: new Date(iso), amount };
}

describe('deriveStatuses', () => {
  it('marks fully covered tramos PAID, greedily in order', () => {
    const tramos = [inst(1, '2026-01-15', 100), inst(2, '2026-02-15', 100)];
    const out = deriveStatuses(tramos, 200, today);
    expect(out.map((t) => t.status)).toEqual(['PAID', 'PAID']);
    expect(out.map((t) => t.covered)).toEqual([100, 100]);
  });

  it('marks a past-due uncovered tramo OVERDUE', () => {
    const tramos = [inst(1, '2026-01-15', 100), inst(2, '2026-04-15', 100)];
    const out = deriveStatuses(tramos, 0, today);
    // seq1 due Jan 15 < today -> OVERDUE; seq2 due Apr 15 > today -> PENDING
    expect(out.map((t) => t.status)).toEqual(['OVERDUE', 'PENDING']);
  });

  it('marks a past-due PARTIALLY covered tramo OVERDUE (not PARTIAL)', () => {
    const tramos = [inst(1, '2026-01-15', 100)];
    const out = deriveStatuses(tramos, 40, today);
    expect(out[0]).toMatchObject({ covered: 40, status: 'OVERDUE' });
  });

  it('DX-472: con lo abonado incompleto ningún tramo sale OVERDUE', () => {
    const tramos = [
      inst(1, '2026-01-15', 100),
      inst(2, '2026-02-15', 100),
      inst(3, '2026-04-15', 100),
    ];
    const out = deriveStatuses(tramos, 140, today, { paidIncomplete: true });
    expect(out.map((t) => t.status)).toEqual(['PAID', 'PARTIAL', 'PENDING']);
  });

  it('marks a future partially covered tramo PARTIAL', () => {
    const tramos = [inst(1, '2026-04-15', 100)];
    const out = deriveStatuses(tramos, 40, today);
    expect(out[0]).toMatchObject({ covered: 40, status: 'PARTIAL' });
  });

  it('marks a future uncovered tramo PENDING', () => {
    const tramos = [inst(1, '2026-04-15', 100)];
    const out = deriveStatuses(tramos, 0, today);
    expect(out[0].status).toBe('PENDING');
  });

  it('allocates the down payment tramo before installments', () => {
    const tramos: ScheduleTramo[] = [
      {
        kind: 'DOWN_PAYMENT',
        sequence: null,
        dueDate: new Date('2026-01-15'),
        amount: 200,
      },
      inst(1, '2026-02-15', 100),
    ];
    const out = deriveStatuses(tramos, 250, today);
    expect(out[0]).toMatchObject({ covered: 200, status: 'PAID' });
    expect(out[1]).toMatchObject({ covered: 50, status: 'OVERDUE' });
  });

  it('does not let coverage exceed a tramo amount (overflow rolls forward)', () => {
    const tramos = [inst(1, '2026-04-10', 100), inst(2, '2026-04-20', 100)];
    const out = deriveStatuses(tramos, 150, today);
    expect(out.map((t) => t.covered)).toEqual([100, 50]);
    expect(out.map((t) => t.status)).toEqual(['PAID', 'PARTIAL']);
  });

  describe('B4 (DX-472-bis): residuo de redondeo al convertir', () => {
    it('JPY sin decimales: 15.000 cubierto con 14.999,87 convertidos queda PAID, no OVERDUE de ¥0', () => {
      const tramos = [inst(1, '2026-01-15', 7500), inst(2, '2026-02-15', 7500)];
      const out = deriveStatuses(tramos, 14999.87, today, {
        roundingDigits: 0,
      });
      expect(out.map((t) => [t.covered, t.status])).toEqual([
        [7500, 'PAID'],
        [7500, 'PAID'],
      ]);
    });

    it('JPY: lo que falta de verdad (medio yen o más) sigue vencido', () => {
      const out = deriveStatuses(
        [inst(1, '2026-01-15', 15000)],
        14999.5,
        today,
        {
          roundingDigits: 0,
        },
      );
      expect(out[0]).toMatchObject({ covered: 14999.5, status: 'OVERDUE' });
    });

    it('USD con 2 decimales: un céntimo que falta es deuda real y sigue vencido', () => {
      const out = deriveStatuses([inst(1, '2026-01-15', 100)], 99.99, today, {
        roundingDigits: 2,
      });
      expect(out[0]).toMatchObject({ covered: 99.99, status: 'OVERDUE' });
    });

    it('sin decimales de la moneda, como antes (2)', () => {
      const out = deriveStatuses(
        [inst(1, '2026-01-15', 15000)],
        14999.87,
        today,
      );
      expect(out[0].status).toBe('OVERDUE');
    });
  });
});
