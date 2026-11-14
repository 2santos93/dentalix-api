import { convertAtRate, toRateColumn } from './rate-conversion';
import { roundToDigits } from './line-rounding';
import { round2 } from './money';

// DX-513-bis: la referencia de un ítem en otra moneda se convierte a la del
// plan con la tasa congelada (unidades por 1 USD) y se redondea UNA vez a los
// dígitos de redondeo de la moneda del plan, la mitad hacia arriba.
describe('convertAtRate (DX-513-bis)', () => {
  it('VES → USD a 880 Bs./USD: 3.600 Bs. son 4,09 USD', () => {
    expect(convertAtRate(3600, { fromPerBase: 880, toPerBase: 1 }, 2)).toBe(
      4.09,
    );
  });

  it('USD → VES a 880: 4,50 USD son 3.960,00 Bs.', () => {
    expect(convertAtRate(4.5, { fromPerBase: 1, toPerBase: 880 }, 2)).toBe(
      3960,
    );
  });

  it('EUR ↔ VES, cruzada por USD (VES 880, EUR 0,92): 3.600 Bs. son 3,76 €', () => {
    // 3600 / 880 × 0,92 = 3,7636… → 3,76
    expect(convertAtRate(3600, { fromPerBase: 880, toPerBase: 0.92 }, 2)).toBe(
      3.76,
    );
    // 3,76 € → VES: 3,76 / 0,92 × 880 = 3.596,52…
    expect(convertAtRate(3.76, { fromPerBase: 0.92, toPerBase: 880 }, 2)).toBe(
      3596.52,
    );
  });

  it('moneda de 0 dígitos en la frontera: 1.234,5 se redondea a 1.235 (la mitad hacia arriba)', () => {
    // 1 USD = 1.234,5 unidades: 1 USD → 1.234,5 → 1.235.
    expect(convertAtRate(1, { fromPerBase: 1, toPerBase: 1234.5 }, 0)).toBe(
      1235,
    );
    expect(
      convertAtRate(1, { fromPerBase: 1, toPerBase: 1234.49999999 }, 0),
    ).toBe(1234);
  });

  it('un solo redondeo: nunca round2 y luego otro (doble redondeo)', () => {
    // 0,0049995 USD por unidad × 100 = 0,49995 → con un paso a 0 dígitos: 0;
    // round2 primero daría 0,50 y luego 1.
    const rate = { fromPerBase: 1, toPerBase: 0.49995 };
    expect(convertAtRate(1, rate, 0)).toBe(0);
    expect(roundToDigits(round2(1 * 0.49995), 0)).toBe(1);
  });

  it('exacto en céntimos aunque la coma flotante no lo sea (0,1 + 0,2 Bs. a 1:1)', () => {
    expect(convertAtRate(0.1 + 0.2, { fromPerBase: 1, toPerBase: 1 }, 2)).toBe(
      0.3,
    );
    // 1,01 USD × 0,995 = 1,00495 → 1,00 (no 1,01 por deriva).
    expect(convertAtRate(1.01, { fromPerBase: 1, toPerBase: 0.995 }, 2)).toBe(
      1,
    );
    expect(convertAtRate(0, { fromPerBase: 880, toPerBase: 1 }, 2)).toBe(0);
  });

  it('rechaza una tasa que no es positiva o un importe negativo', () => {
    expect(() => convertAtRate(1, { fromPerBase: 0, toPerBase: 1 }, 2)).toThrow(
      RangeError,
    );
    expect(() =>
      convertAtRate(-1, { fromPerBase: 1, toPerBase: 1 }, 2),
    ).toThrow(RangeError);
  });
});

describe('toRateColumn (DX-513-bis, como DX-375)', () => {
  it('deja la tasa con los 8 decimales de su columna', () => {
    expect(toRateColumn(880.123456789)).toBe(880.12345679);
    expect(toRateColumn(1)).toBe(1);
  });
});
