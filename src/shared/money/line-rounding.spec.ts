import fc from 'fast-check';
import {
  lineCents,
  linesTotal,
  linesTotalCents,
  percentOfCentsInUnits,
  roundToDigits,
  roundingDigits,
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

  it('123,45 × 7,5 %: 9 con 0 dígitos (RSD/COP/JPY hoy) y 9,26 con 2 (EUR)', () => {
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
