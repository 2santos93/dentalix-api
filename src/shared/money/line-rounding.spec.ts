import fc from 'fast-check';
import {
  fitsRoundingDigits,
  lineCents,
  linesTotal,
  linesTotalCents,
  percentOfCentsInUnits,
  roundToDigits,
  roundingDigits,
  scaleAmount,
  unitCents,
  unitsToAmount,
} from './line-rounding';

describe('redondeo por línea (DX-340)', () => {
  it('solo admite 0, 1 o 2 dígitos: 3 (KWD, BHD…) se rechaza, no se trunca', () => {
    expect(roundingDigits(0)).toBe(0);
    expect(roundingDigits(2)).toBe(2);
    expect(() => roundingDigits(3)).toThrow(RangeError);
    expect(() => roundingDigits(-1)).toThrow(RangeError);
    expect(() => roundingDigits(1.5)).toThrow(RangeError);
    expect(() => unitCents(3 as 2)).toThrow(/como mucho 2 decimales/);
  });

  it('la unidad en céntimos es 100, 10 o 1', () => {
    expect(unitCents(0)).toBe(100n);
    expect(unitCents(1)).toBe(10n);
    expect(unitCents(2)).toBe(1n);
  });

  it('roundToDigits redondea la mitad hacia arriba sin deriva de coma flotante', () => {
    expect(roundToDigits(12345.5, 0)).toBe(12346);
    expect(roundToDigits(12345.49, 0)).toBe(12345);
    expect(roundToDigits(10.005, 2)).toBe(10.01);
    expect(roundToDigits(10.004, 2)).toBe(10);
    expect(roundToDigits(1.05, 1)).toBe(1.1);
  });

  it('123,45 × 7,5 %: 9 con 0 dígitos (RSD/USD/JPY hoy) y 9,26 con 2 (EUR)', () => {
    const cents = 12345n;
    expect(
      unitsToAmount(percentOfCentsInUnits(cents, 750n, 0, 'half-up'), 0),
    ).toBe(9);
    expect(
      unitsToAmount(percentOfCentsInUnits(cents, 750n, 2, 'half-up'), 2),
    ).toBe(9.26);
    expect(
      unitsToAmount(percentOfCentsInUnits(cents, 750n, 2, 'floor'), 2),
    ).toBe(9.25);
  });

  it('el total es la suma exacta de las líneas (0,1 + 0,2 = 0,3)', () => {
    const lines = [
      { price: 0.1, discount: 0 },
      { price: 0.2, discount: 0 },
      { price: 123.45, discount: 9.26 },
    ];
    expect(lineCents(lines[2])).toBe(11419);
    expect(linesTotalCents(lines)).toBe(11449);
    expect(linesTotal(lines)).toBe(114.49);
    expect(linesTotal([])).toBe(0);
  });

  it('propiedad: el total coincide con la suma de líneas en Decimal para miles de planes', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .tuple(
              fc.integer({ min: 0, max: 99_999_999 }),
              fc.integer({ min: 0, max: 100 }),
            )
            .map(([cents, pct]) => ({
              price: cents / 100,
              discount: Math.floor((cents * pct) / 100) / 100,
            })),
          { maxLength: 40 },
        ),
        (lines) => {
          const exact = lines.reduce(
            (sum, l) =>
              sum +
              BigInt(Math.round(l.price * 100)) -
              BigInt(Math.round(l.discount * 100)),
            0n,
          );
          expect(BigInt(linesTotalCents(lines))).toBe(exact);
          expect(linesTotal(lines)).toBe(Number(exact) / 100);
        },
      ),
      { numRuns: 3000 },
    );
  });
});

describe('fitsRoundingDigits (DX-488, antes en payment-adjustments)', () => {
  it('USD/VES a 2 decimales, JPY a 0, y rechaza el resto', () => {
    expect(fitsRoundingDigits(12.34, 2)).toBe(true);
    expect(fitsRoundingDigits(12.345, 2)).toBe(false);
    expect(fitsRoundingDigits(1500, 0)).toBe(true);
    expect(fitsRoundingDigits(1500.5, 0)).toBe(false);
    expect(fitsRoundingDigits(12.3, 1)).toBe(true);
    expect(fitsRoundingDigits(12.34, 1)).toBe(false);
    expect(fitsRoundingDigits(0.1 + 0.2, 2)).toBe(true);
  });
});

describe('scaleAmount (DX-379: recotizar en proporción)', () => {
  it('amount × num ÷ den, redondeado UNA vez a la unidad, la mitad hacia arriba', () => {
    // 85 de 100 → sobre 250 = 212,50
    expect(scaleAmount(250, 85, 100, 2, 'half-up')).toBe(212.5);
    // 1/3 de 100 = 33,333… → 33,33
    expect(scaleAmount(100, 1, 3, 2, 'half-up')).toBe(33.33);
    // 2/3 de 100 = 66,666… → 66,67
    expect(scaleAmount(100, 2, 3, 2, 'half-up')).toBe(66.67);
    // Sin decimales (moneda de 0 dígitos): 1 234,5 → 1 235
    expect(scaleAmount(2469, 1, 2, 0, 'half-up')).toBe(1235);
    expect(scaleAmount(2469, 1, 2, 0, 'floor')).toBe(1234);
    expect(scaleAmount(2469, 1, 2, 0, 'ceil')).toBe(1235);
    expect(scaleAmount(100, 1, 3, 2, 'ceil')).toBe(33.34);
    // Exacto: ceil no sube.
    expect(scaleAmount(250, 85, 100, 2, 'ceil')).toBe(212.5);
  });

  it('sin deriva de coma flotante (10,05 × 1 ÷ 1 = 10,05)', () => {
    expect(scaleAmount(10.05, 1, 1, 2, 'half-up')).toBe(10.05);
    expect(scaleAmount(0.1, 3, 1, 2, 'half-up')).toBe(0.3);
  });

  it('rechaza un denominador 0 y los negativos', () => {
    expect(() => scaleAmount(100, 1, 0, 2, 'half-up')).toThrow(RangeError);
    expect(() => scaleAmount(-1, 1, 1, 2, 'half-up')).toThrow(RangeError);
    expect(() => scaleAmount(1, -1, 1, 2, 'half-up')).toThrow(RangeError);
  });

  it('nunca supera amount cuando num ≤ den (floor)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (cents, a, b) => {
          const [num, den] = a <= b ? [a, b] : [b, a || 1];
          const amount = cents / 100;
          return scaleAmount(amount, num, den, 2, 'floor') <= amount;
        },
      ),
    );
  });
});
