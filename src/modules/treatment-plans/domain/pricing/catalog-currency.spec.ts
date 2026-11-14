import { catalogCurrencyOf, clinicCatalogCurrency } from './catalog-currency';

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

describe('clinicCatalogCurrency (DX-502-bis)', () => {
  it('la moneda fijada por la clínica manda, aunque las sedes no compartan moneda', () => {
    expect(
      clinicCatalogCurrency('USD', [{ currency: 'USD' }, { currency: 'VES' }]),
    ).toBe('USD');
  });

  it('también frente a una moneda común distinta: no se deduce nada', () => {
    expect(
      clinicCatalogCurrency('USD', [{ currency: 'VES' }, { currency: 'VES' }]),
    ).toBe('USD');
  });

  it('sin moneda fijada, la regla de siempre: la común de las sedes activas', () => {
    expect(
      clinicCatalogCurrency(null, [{ currency: 'VES' }, { currency: 'VES' }]),
    ).toBe('VES');
  });

  it('sin moneda fijada ni moneda común, no se sabe', () => {
    expect(
      clinicCatalogCurrency(null, [{ currency: 'USD' }, { currency: 'VES' }]),
    ).toBeNull();
    expect(clinicCatalogCurrency(null, [])).toBeNull();
  });
});
