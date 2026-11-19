import { normalizeReference } from '../../payment-methods/domain/payment-method-rules';
import {
  addDays,
  autoMatch,
  classifyPeriod,
  daysBetween,
  type MovementForMatch,
  type PaymentForMatch,
} from './matching';

const OPTS = { toleranceCents: 0, windowDays: 5 };

const mv = (
  id: string,
  ref: string | null,
  cents: number,
  bookedOn = '2026-10-15',
): MovementForMatch => ({
  id,
  bookedOn,
  referenceNormalized: normalizeReference(ref),
  amountCents: cents,
});
const pay = (
  id: string,
  ref: string | null,
  cents: number,
  paidOn = '2026-10-15',
): PaymentForMatch => ({
  id,
  paidOn,
  referenceNormalized: normalizeReference(ref),
  collectedCents: cents,
});

describe('DX-571 · emparejado (unit)', () => {
  it('criterio del ticket: referencia 004512 y mismo importe → conciliado solo', () => {
    expect(
      autoMatch(
        [mv('m1', '004512', 4500_00)],
        [pay('p1', '004512', 4500_00)],
        OPTS,
      ),
    ).toEqual([{ movementId: 'm1', paymentId: 'p1' }]);
  });

  it('empareja con la MISMA normalización que DX-395 (espacios, puntos, guiones, mayúsculas)', () => {
    expect(
      autoMatch(
        [mv('m1', '00-45 12', 100_00), mv('m2', 'ab.12', 50_00)],
        [pay('p1', '004512', 100_00), pay('p2', 'AB12', 50_00)],
        OPTS,
      ),
    ).toEqual([
      { movementId: 'm1', paymentId: 'p1' },
      { movementId: 'm2', paymentId: 'p2' },
    ]);
  });

  it('no empareja una referencia parcial, ni sin referencia', () => {
    expect(
      autoMatch(
        [mv('m1', '1234004512', 100_00), mv('m2', null, 100_00)],
        [pay('p1', '004512', 100_00), pay('p2', null, 100_00)],
        OPTS,
      ),
    ).toEqual([]);
  });

  it('importe dentro de la tolerancia sí; fuera, no', () => {
    const m = [mv('m1', '77', 100_05)];
    expect(
      autoMatch(m, [pay('p1', '77', 100_00)], { ...OPTS, toleranceCents: 5 }),
    ).toHaveLength(1);
    expect(
      autoMatch(m, [pay('p1', '77', 100_00)], { ...OPTS, toleranceCents: 4 }),
    ).toEqual([]);
  });

  it('fuera de la ventana de días no empareja', () => {
    expect(
      autoMatch(
        [mv('m1', '77', 100, '2026-10-21')],
        [pay('p1', '77', 100, '2026-10-15')],
        OPTS,
      ),
    ).toEqual([]);
    expect(
      autoMatch(
        [mv('m1', '77', 100, '2026-10-20')],
        [pay('p1', '77', 100, '2026-10-15')],
        OPTS,
      ),
    ).toHaveLength(1);
  });

  it('1:1 y determinista: dos abonos con la misma referencia, gana el más cercano', () => {
    const movements = [
      mv('m1', '9', 100, '2026-10-15'),
      mv('m2', '9', 100, '2026-10-18'),
    ];
    const payments = [
      pay('pA', '9', 100, '2026-10-17'),
      pay('pB', '9', 100, '2026-10-15'),
    ];
    const expected = [
      { movementId: 'm1', paymentId: 'pB' },
      { movementId: 'm2', paymentId: 'pA' },
    ];
    expect(autoMatch(movements, payments, OPTS)).toEqual(expected);
    expect(
      autoMatch([...movements].reverse(), [...payments].reverse(), OPTS),
    ).toEqual(expected);
  });

  it('dos movimientos y un abono: solo uno se empareja', () => {
    expect(
      autoMatch(
        [mv('m1', '9', 100), mv('m2', '9', 100)],
        [pay('p1', '9', 100)],
        OPTS,
      ),
    ).toHaveLength(1);
  });

  it('5 000 movimientos se emparejan sin recorrer pares por fuerza bruta', () => {
    const movements = Array.from({ length: 5000 }, (_, i) =>
      mv(`m${i}`, `R${i}`, 100 + i),
    );
    const payments = Array.from({ length: 5000 }, (_, i) =>
      pay(`p${i}`, `R${i}`, 100 + i),
    );
    expect(autoMatch(movements, payments, OPTS)).toHaveLength(5000);
  });

  describe('listas del período', () => {
    it('importe distinto, sin abono y sin movimiento', () => {
      const result = classifyPeriod(
        [mv('m1', '11', 100_00), mv('m2', '22', 50_00)],
        [
          pay('p1', '11', 90_00),
          pay('p3', '33', 10_00),
          pay('p4', '44', 10_00, '2026-09-01'),
        ],
        (p) => p.paidOn >= '2026-10-01',
        OPTS,
      );
      expect(result).toEqual({
        amountMismatch: [{ movementId: 'm1', paymentId: 'p1' }],
        movementsWithoutPayment: ['m2'],
        paymentsWithoutMovement: ['p3'],
      });
    });

    it('un abono fuera del período que forma «importe distinto» con un movimiento del período sí sale en el par', () => {
      const result = classifyPeriod(
        [mv('m1', '11', 100_00, '2026-10-01')],
        [pay('p1', '11', 90_00, '2026-09-29')],
        (p) => p.paidOn >= '2026-10-01',
        OPTS,
      );
      expect(result.amountMismatch).toEqual([
        { movementId: 'm1', paymentId: 'p1' },
      ]);
      expect(result.paymentsWithoutMovement).toEqual([]);
    });
  });

  it('fechas', () => {
    expect(daysBetween('2026-10-01', '2026-09-29')).toBe(2);
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });
});
