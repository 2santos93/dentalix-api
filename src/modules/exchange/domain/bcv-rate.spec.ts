import {
  BCV_MAX_AGE_DAYS,
  bcvOldestValueDate,
  bcvRatesPerUsd,
  bcvSanityProblem,
  parseEsDecimal,
} from './bcv-rate';

describe('tasa del BCV (DX-585)', () => {
  describe('parseEsDecimal', () => {
    it.each([
      ['918,76620000', 918.7662],
      ['919,82270000', 919.8227],
      ['1.011,17949056', 1011.17949056],
      [' 1.011,17949056 ', 1011.17949056],
      ['36,5', 36.5],
      ['1.234.567,8', 1234567.8],
      ['918', 918],
    ])('lee «%s» como %d', (text, expected) => {
      expect(parseEsDecimal(text)).toBe(expected);
    });

    it.each([
      '',
      'abc',
      '918.77',
      '1,2,3',
      '1.01,5',
      '12.3456,7',
      '-918,7',
      '918,',
    ])('no inventa un número con «%s»', (text) => {
      expect(parseEsDecimal(text)).toBeNull();
    });
  });

  describe('bcvSanityProblem', () => {
    const ok = {
      usdVes: 918.7662,
      eurVes: 1011.17949056,
      valueDate: '2026-11-24',
    };

    it('una tasa normal pasa, con y sin anterior', () => {
      expect(bcvSanityProblem(ok, null)).toBeNull();
      expect(
        bcvSanityProblem(ok, { usdVes: 917.62, eurVes: 1009.5 }),
      ).toBeNull();
    });

    it('rechaza tasas no positivas o no finitas', () => {
      expect(bcvSanityProblem({ ...ok, usdVes: 0 }, null)).toBe(
        'tasa no positiva',
      );
      expect(bcvSanityProblem({ ...ok, eurVes: -1 }, null)).toBe(
        'tasa no positiva',
      );
      expect(bcvSanityProblem({ ...ok, usdVes: Number.NaN }, null)).toBe(
        'tasa no positiva',
      );
    });

    it('rechaza una fecha valor que no existe', () => {
      expect(bcvSanityProblem({ ...ok, valueDate: '2026-02-30' }, null)).toBe(
        'fecha valor inválida',
      );
    });

    it('rechaza EUR/USD fuera de ±50 % (p. ej. las cifras cruzadas o sin decimales)', () => {
      expect(bcvSanityProblem({ ...ok, eurVes: 101117949056 }, null)).toBe(
        'EUR/USD fuera de rango',
      );
      expect(bcvSanityProblem({ ...ok, eurVes: 400 }, null)).toBe(
        'EUR/USD fuera de rango',
      );
      // EUR más barato que el USD pero dentro de ±50 %: pasa.
      expect(bcvSanityProblem({ ...ok, eurVes: 700 }, null)).toBeNull();
    });

    it('rechaza una variación de 30 % o más frente a la anterior, en cualquiera de las dos', () => {
      const previous = { usdVes: 700, eurVes: 800 };
      expect(
        bcvSanityProblem({ ...ok, usdVes: 910, eurVes: 1000 }, previous),
      ).toBe('variación >= 30 % frente a la última guardada');
      expect(
        bcvSanityProblem({ ...ok, usdVes: 700, eurVes: 1040 }, previous),
      ).toBe('variación >= 30 % frente a la última guardada');
      expect(
        bcvSanityProblem({ ...ok, usdVes: 890, eurVes: 1000 }, previous),
      ).toBeNull();
    });
  });

  it('bcvRatesPerUsd: VES = Bs. por USD; EUR = Bs./USD ÷ Bs./EUR con 8 decimales', () => {
    expect(bcvRatesPerUsd({ usdVes: 918.7662, eurVes: 1011.17949056 })).toEqual(
      {
        VES: 918.7662,
        EUR: 0.90860842,
      },
    );
  });

  it(`bcvOldestValueDate: ${BCV_MAX_AGE_DAYS} días atrás`, () => {
    expect(bcvOldestValueDate('2026-11-24')).toBe('2026-11-17');
    expect(bcvOldestValueDate('2027-01-03')).toBe('2026-12-27');
  });
});
