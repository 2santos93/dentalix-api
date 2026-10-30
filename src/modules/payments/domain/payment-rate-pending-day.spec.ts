import { pendingOnDayOf } from './payment-rate-pending-day';

// DX-402: la vista previa del formulario de tasa manual solo promete el
// respaldo a los abonos a los que de verdad servirá: una cotización con
// respaldo necesita las DOS monedas del abono (salvo USD, la base) ese día.
describe('pendingOnDayOf (DX-402)', () => {
  const none = new Set<string>();

  it('cuenta los abonos cuya otra moneda es la base: la tasa elegida basta', () => {
    expect(
      pendingOnDayOf(
        [
          { currency: 'USD', targetCurrency: 'COP' },
          { currency: 'COP', targetCurrency: 'USD' },
        ],
        'COP',
        none,
        false,
      ),
    ).toEqual({
      count: 2,
      providerRateSaved: false,
      otherRatesMissing: { count: 0, currencies: [] },
    });
  });

  it('entre dos monedas no USD, sin la tasa manual de la otra ese día, no promete el respaldo y dice cuál falta', () => {
    expect(
      pendingOnDayOf(
        [
          { currency: 'EUR', targetCurrency: 'COP' },
          { currency: 'PEN', targetCurrency: 'COP' },
          { currency: 'PEN', targetCurrency: 'COP' },
          { currency: 'USD', targetCurrency: 'COP' },
        ],
        'COP',
        none,
        false,
      ),
    ).toEqual({
      count: 1,
      providerRateSaved: false,
      otherRatesMissing: { count: 3, currencies: ['EUR', 'PEN'] },
    });
  });

  it('entre dos monedas no USD, con la tasa manual de la otra ya registrada ese día, la cuenta', () => {
    expect(
      pendingOnDayOf(
        [{ currency: 'EUR', targetCurrency: 'COP' }],
        'COP',
        new Set(['EUR']),
        false,
      ),
    ).toEqual({
      count: 1,
      providerRateSaved: false,
      otherRatesMissing: { count: 0, currencies: [] },
    });
  });

  it('ignora los abonos que no necesitan esa moneda o que ya están en la moneda de su destino', () => {
    expect(
      pendingOnDayOf(
        [
          { currency: 'EUR', targetCurrency: 'USD' },
          { currency: 'COP', targetCurrency: 'COP' },
        ],
        'COP',
        none,
        true,
      ),
    ).toEqual({
      count: 0,
      providerRateSaved: true,
      otherRatesMissing: { count: 0, currencies: [] },
    });
  });
});
