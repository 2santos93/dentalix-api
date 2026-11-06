import { catalogCurrencyOf } from './catalog-currency';

describe('catalogCurrencyOf (DX-502)', () => {
  it('es la moneda común de las sedes activas', () => {
    expect(catalogCurrencyOf([{ currency: 'VES' }, { currency: 'VES' }])).toBe(
      'VES',
    );
  });

  it('con sedes en monedas distintas no hay moneda del catálogo', () => {
    expect(
      catalogCurrencyOf([{ currency: 'VES' }, { currency: 'EUR' }]),
    ).toBeNull();
  });

  it('una sede sin moneda la deja sin saber', () => {
    expect(catalogCurrencyOf([{ currency: 'VES' }, { currency: null }])).toBe(
      null,
    );
  });

  it('sin sedes activas, tampoco', () => {
    expect(catalogCurrencyOf([])).toBeNull();
  });
});
