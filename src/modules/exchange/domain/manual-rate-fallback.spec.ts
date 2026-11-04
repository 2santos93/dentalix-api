import {
  MANUAL_RATE_MAX_AGE_DEFAULT,
  isValidManualRateMaxAge,
  selectManualRate,
  selectManualRatesForPair,
  type ManualRateRow,
} from './manual-rate-fallback';

const ves = (date: string, rate: number): ManualRateRow => ({
  date,
  currency: 'VES',
  rate,
});

describe('selectManualRate (DX-384)', () => {
  const friday = [ves('2026-10-30', 36.5)];

  it('usa la del viernes el sábado y el lunes con N=3 (el lunes son 3 días)', () => {
    expect(selectManualRate('2026-10-31', 3, friday)).toEqual({
      rate: 36.5,
      rateDate: '2026-10-30',
    });
    expect(selectManualRate('2026-11-02', 3, friday)).toEqual({
      rate: 36.5,
      rateDate: '2026-10-30',
    });
  });

  it('con la última tasa de hace 4 días no hay tasa', () => {
    expect(selectManualRate('2026-11-03', 3, friday)).toBeNull();
  });

  it('N=0 es solo el día exacto', () => {
    expect(selectManualRate('2026-10-30', 0, friday)).toEqual({
      rate: 36.5,
      rateDate: '2026-10-30',
    });
    expect(selectManualRate('2026-10-31', 0, friday)).toBeNull();
  });

  it('una tasa posterior al día nunca se usa', () => {
    expect(selectManualRate('2026-10-29', 3, friday)).toBeNull();
    expect(
      selectManualRate('2026-10-29', 3, [ves('2026-10-30', 36.5)]),
    ).toBeNull();
  });

  it('elige la de mayor fecha dentro del plazo y prefiere la del propio día', () => {
    const rows = [
      ves('2026-10-28', 35),
      ves('2026-10-30', 36.5),
      ves('2026-10-31', 37),
      ves('2026-11-01', 38),
    ];
    expect(selectManualRate('2026-10-31', 3, rows)?.rateDate).toBe(
      '2026-10-31',
    );
    expect(selectManualRate('2026-10-31', 3, rows)?.rate).toBe(37);
    expect(selectManualRate('2026-10-30', 3, rows)?.rateDate).toBe(
      '2026-10-30',
    );
  });

  it('cruza el fin de mes y de año por días civiles, no por restas de texto', () => {
    expect(
      selectManualRate('2027-01-02', 3, [ves('2026-12-30', 40)])?.rateDate,
    ).toBe('2026-12-30');
    expect(
      selectManualRate('2027-01-03', 3, [ves('2026-12-30', 40)]),
    ).toBeNull();
    // 2028 es bisiesto: del 28/02 al 01/03 hay 2 días.
    expect(
      selectManualRate('2028-03-01', 2, [ves('2028-02-28', 41)])?.rateDate,
    ).toBe('2028-02-28');
    expect(
      selectManualRate('2028-03-01', 1, [ves('2028-02-28', 41)]),
    ).toBeNull();
  });

  it('sin tasas, sin tasa', () => {
    expect(selectManualRate('2026-10-31', 3, [])).toBeNull();
  });
});

describe('selectManualRatesForPair (DX-384)', () => {
  const eur = (date: string, rate: number): ManualRateRow => ({
    date,
    currency: 'EUR',
    rate,
  });

  it('sin monedas distintas de USD no hay nada que buscar: la del propio día', () => {
    expect(selectManualRatesForPair('2026-10-31', 3, [], [])).toEqual({
      rateDate: '2026-10-31',
      rates: {},
    });
  });

  it('toma las dos monedas de UNA misma fecha, la mayor dentro del plazo con las dos', () => {
    const rows = [
      eur('2026-10-30', 0.92),
      ves('2026-10-30', 36.5),
      ves('2026-10-31', 37), // VES más nueva, pero sin EUR ese día
    ];
    expect(
      selectManualRatesForPair('2026-10-31', 3, ['EUR', 'VES'], rows),
    ).toEqual({ rateDate: '2026-10-30', rates: { EUR: 0.92, VES: 36.5 } });
  });

  it('si las dos no coinciden dentro del plazo, no hay tasa (nunca se mezclan fechas)', () => {
    const rows = [eur('2026-10-27', 0.92), ves('2026-10-30', 36.5)];
    expect(
      selectManualRatesForPair('2026-10-31', 3, ['EUR', 'VES'], rows),
    ).toBeNull();
  });

  it('con una sola moneda equivale a selectManualRate', () => {
    expect(
      selectManualRatesForPair(
        '2026-10-31',
        3,
        ['VES'],
        [ves('2026-10-30', 36.5)],
      ),
    ).toEqual({ rateDate: '2026-10-30', rates: { VES: 36.5 } });
  });
});

describe('plazo de la tasa manual', () => {
  it('3 días por defecto y de 0 a 30 enteros', () => {
    expect(MANUAL_RATE_MAX_AGE_DEFAULT).toBe(3);
    for (const ok of [0, 1, 3, 30])
      expect(isValidManualRateMaxAge(ok)).toBe(true);
    for (const bad of [-1, 31, 1.5, NaN, '3', null, undefined]) {
      expect(isValidManualRateMaxAge(bad)).toBe(false);
    }
  });
});
