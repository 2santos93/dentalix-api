import { CURRENCY_DIGITS } from '../../../prisma/reference/currency-digits';
import { ISO4217_CURRENCIES } from '../../../prisma/reference/iso4217';
import { currencySeedUpserts } from './currency-seed';

describe('seed de monedas (DX-340)', () => {
  const upserts = currencySeedUpserts(ISO4217_CURRENCIES, CURRENCY_DIGITS);

  it('una moneda nueva nace con los decimales de la referencia', () => {
    const rsd = upserts.find((u) => u.where.code === 'RSD');
    expect(rsd?.create).toMatchObject({
      code: 'RSD',
      minorUnits: 2,
      roundingDigits: 0,
    });
    expect(upserts).toHaveLength(ISO4217_CURRENCIES.length);
  });

  it('volver a sembrar NO pisa los decimales: un cambio de datos (migración) manda', () => {
    for (const { update } of upserts) {
      expect(Object.keys(update).sort()).toEqual(['name', 'symbol']);
    }
  });

  it('una moneda sin decimales de referencia es un error, no un 2 por defecto', () => {
    expect(() =>
      currencySeedUpserts(
        [{ code: 'ZZZ', name: 'Prueba', symbol: '¤' }],
        CURRENCY_DIGITS,
      ),
    ).toThrow(/ZZZ sin decimales de referencia/);
  });
});
