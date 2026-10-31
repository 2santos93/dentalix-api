import { AgreementKind, PriceSource } from '@prisma/client';
import { roundToCurrency } from '../../../discounts/domain/discount-policy';
import {
  percentPrice,
  resolveItemPrice,
  type PricingAgreement,
  type PricingContext,
} from './resolve-item-price';

const TODAY = '2026-10-20';
const SEDE = 'loc-norte';

function percentAgreement(
  overrides: Partial<PricingAgreement> = {},
): PricingAgreement {
  return {
    id: 'agr-1',
    name: 'Surco Salud',
    kind: AgreementKind.PERCENT_DISCOUNT,
    percent: 15,
    percentByCategory: null,
    priceListId: null,
    locationId: null,
    active: true,
    validFrom: null,
    validTo: null,
    assignmentValidFrom: null,
    assignmentValidTo: null,
    ...overrides,
  };
}

function listAgreement(
  overrides: Partial<PricingAgreement> = {},
): PricingAgreement {
  return percentAgreement({
    id: 'agr-2',
    name: 'Empresa X',
    kind: AgreementKind.PRICE_LIST,
    percent: null,
    priceListId: 'list-agr',
    ...overrides,
  });
}

function ctx(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    catalogItem: {
      defaultPrice: 100000,
      category: 'Endodoncia',
      allowDiscount: true,
    },
    planCurrency: 'COP',
    today: TODAY,
    locationId: SEDE,
    agreement: null,
    agreementListPrice: null,
    locationList: null,
    ...overrides,
  };
}

const CATALOG = {
  basePrice: 100000,
  price: 100000,
  source: PriceSource.CATALOG,
  agreementId: null,
  agreementName: null,
  allowDiscount: true,
};

describe('resolveItemPrice (DX-105 §3)', () => {
  it('sin convenio ni lista: precio de catálogo', () => {
    expect(resolveItemPrice(ctx())).toEqual(CATALOG);
  });

  it('sin convenio ni lista ni precio de catálogo: precio null (el caso de uso lo pide)', () => {
    expect(
      resolveItemPrice(
        ctx({
          catalogItem: {
            defaultPrice: null,
            category: null,
            allowDiscount: true,
          },
        }),
      ),
    ).toEqual({ ...CATALOG, basePrice: null, price: null });
  });

  it('convenio % general: base × (1 − p/100), con nombre y id del convenio', () => {
    expect(resolveItemPrice(ctx({ agreement: percentAgreement() }))).toEqual({
      basePrice: 100000,
      price: 85000,
      source: PriceSource.AGREEMENT_PERCENT,
      agreementId: 'agr-1',
      agreementName: 'Surco Salud',
      allowDiscount: true,
    });
  });

  it('convenio % por categoría: gana el de la categoría, comparada normalizada', () => {
    const agreement = percentAgreement({
      percentByCategory: { 'ENDODÓNCIA ': 30, Ortodoncia: 5 },
    });
    expect(
      resolveItemPrice(
        ctx({
          agreement,
          catalogItem: {
            defaultPrice: 100000,
            category: 'endodoncia',
            allowDiscount: true,
          },
        }),
      ).price,
    ).toBe(70000);
  });

  it('convenio % con categoría sin entrada propia, o ítem sin categoría: el % general', () => {
    const agreement = percentAgreement({
      percentByCategory: { Ortodoncia: 5 },
    });
    expect(resolveItemPrice(ctx({ agreement })).price).toBe(85000);
    expect(
      resolveItemPrice(
        ctx({
          agreement,
          catalogItem: {
            defaultPrice: 100000,
            category: null,
            allowDiscount: true,
          },
        }),
      ).price,
    ).toBe(85000);
  });

  it('convenio % y prestación sin descuentos: el convenio no aplica (cae a lista de sede o catálogo)', () => {
    const noDiscount = {
      defaultPrice: 100000,
      category: 'Endodoncia',
      allowDiscount: false,
    };
    expect(
      resolveItemPrice(
        ctx({ agreement: percentAgreement(), catalogItem: noDiscount }),
      ),
    ).toEqual({ ...CATALOG, allowDiscount: false });
    expect(
      resolveItemPrice(
        ctx({
          agreement: percentAgreement(),
          catalogItem: noDiscount,
          locationList: { price: 90000, currency: 'COP' },
        }),
      ),
    ).toEqual({
      ...CATALOG,
      price: 90000,
      source: PriceSource.PRICE_LIST,
      allowDiscount: false,
    });
  });

  it('convenio % sin precio de catálogo: no hay base, cae al paso siguiente', () => {
    expect(
      resolveItemPrice(
        ctx({
          agreement: percentAgreement(),
          catalogItem: {
            defaultPrice: null,
            category: null,
            allowDiscount: true,
          },
        }),
      ),
    ).toEqual({ ...CATALOG, basePrice: null, price: null });
  });

  it('lista del convenio con precio para el ítem: precio pactado, aunque no admita descuentos', () => {
    const result = resolveItemPrice(
      ctx({
        agreement: listAgreement(),
        agreementListPrice: { price: 72000, currency: 'COP', active: true },
        catalogItem: {
          defaultPrice: 100000,
          category: null,
          allowDiscount: false,
        },
      }),
    );
    expect(result).toEqual({
      basePrice: 100000,
      price: 72000,
      source: PriceSource.AGREEMENT_PRICE_LIST,
      agreementId: 'agr-2',
      agreementName: 'Empresa X',
      allowDiscount: false,
    });
  });

  it('lista del convenio sin precio para el ítem: cae a la lista de la sede', () => {
    expect(
      resolveItemPrice(
        ctx({
          agreement: listAgreement(),
          agreementListPrice: null,
          locationList: { price: 95000, currency: 'COP' },
        }),
      ),
    ).toEqual({ ...CATALOG, price: 95000, source: PriceSource.PRICE_LIST });
  });

  it('lista del convenio inactiva o en otra moneda: no aplica (R12)', () => {
    const agreement = listAgreement();
    expect(
      resolveItemPrice(
        ctx({
          agreement,
          agreementListPrice: { price: 72000, currency: 'COP', active: false },
        }),
      ),
    ).toEqual(CATALOG);
    expect(
      resolveItemPrice(
        ctx({
          agreement,
          agreementListPrice: { price: 72000, currency: 'USD', active: true },
        }),
      ),
    ).toEqual(CATALOG);
  });

  it('lista activa de la sede en la moneda del plan con precio: PRICE_LIST', () => {
    expect(
      resolveItemPrice(
        ctx({ locationList: { price: 95000, currency: 'COP' } }),
      ),
    ).toEqual({ ...CATALOG, price: 95000, source: PriceSource.PRICE_LIST });
  });

  it('lista de la sede en otra moneda o sin precio para el ítem: catálogo (R12)', () => {
    expect(
      resolveItemPrice(
        ctx({ locationList: { price: 95000, currency: 'USD' } }),
      ),
    ).toEqual(CATALOG);
    expect(
      resolveItemPrice(ctx({ locationList: { price: null, currency: 'COP' } })),
    ).toEqual(CATALOG);
  });

  it('el convenio gana a la lista de la sede', () => {
    expect(
      resolveItemPrice(
        ctx({
          agreement: percentAgreement(),
          locationList: { price: 95000, currency: 'COP' },
        }),
      ).source,
    ).toBe(PriceSource.AGREEMENT_PERCENT);
  });

  it('convenio de otra sede: no aplica; de la sede del request o de toda la clínica, sí', () => {
    expect(
      resolveItemPrice(
        ctx({ agreement: percentAgreement({ locationId: 'loc-sur' }) }),
      ),
    ).toEqual(CATALOG);
    expect(
      resolveItemPrice(
        ctx({ agreement: percentAgreement({ locationId: SEDE }) }),
      ).source,
    ).toBe(PriceSource.AGREEMENT_PERCENT);
  });

  it('convenio inactivo: no aplica', () => {
    expect(
      resolveItemPrice(ctx({ agreement: percentAgreement({ active: false }) })),
    ).toEqual(CATALOG);
  });

  describe('vigencias (extremos incluidos, convenio Y asignación)', () => {
    const applies = (overrides: Partial<PricingAgreement>) =>
      resolveItemPrice(ctx({ agreement: percentAgreement(overrides) }))
        .source === PriceSource.AGREEMENT_PERCENT;

    it.each([
      ['convenio desde hoy', { validFrom: TODAY }, true],
      ['convenio hasta hoy', { validTo: TODAY }, true],
      [
        'convenio de un solo día, hoy',
        { validFrom: TODAY, validTo: TODAY },
        true,
      ],
      ['convenio desde mañana', { validFrom: '2026-10-21' }, false],
      ['convenio vencido ayer', { validTo: '2026-10-19' }, false],
      ['asignación desde hoy', { assignmentValidFrom: TODAY }, true],
      ['asignación hasta hoy', { assignmentValidTo: TODAY }, true],
      ['asignación desde mañana', { assignmentValidFrom: '2026-10-21' }, false],
      ['asignación vencida ayer', { assignmentValidTo: '2026-10-19' }, false],
      [
        'convenio vigente pero asignación vencida',
        {
          validFrom: '2026-01-01',
          validTo: '2026-12-31',
          assignmentValidTo: '2026-10-19',
        },
        false,
      ],
    ] as const)('%s → aplica: %s', (_label, overrides, expected) => {
      expect(applies(overrides)).toBe(expected);
    });
  });

  describe('redondeo a la moneda del plan (R6)', () => {
    it('COP sin decimales, la mitad hacia arriba', () => {
      // 33 333 × 0,85 = 28 333,05 → 28 333; 10 001 × 0,85 = 8 500,85 → 8 501.
      expect(percentPrice(33333, 15, 'COP')).toBe(28333);
      expect(percentPrice(10001, 15, 'COP')).toBe(8501);
      // 7,5 %: 99 999 × 0,925 = 92 499,075 → 92 499; 1 × 0,5 = 0,5 → 1.
      expect(percentPrice(99999, 7.5, 'COP')).toBe(92499);
      expect(percentPrice(1, 50, 'COP')).toBe(1);
    });

    it('USD a céntimos, la mitad hacia arriba sin perderla por coma flotante', () => {
      // 10,01 × 0,5 = 5,005 → 5,01 (en coma flotante 5,005 sería 5,00499…).
      expect(percentPrice(10.01, 50, 'USD')).toBe(5.01);
      expect(percentPrice(123.45, 7.5, 'USD')).toBe(114.19);
      expect(percentPrice(19.99, 12.34, 'USD')).toBe(
        roundToCurrency(19.99 * (1 - 0.1234), 'USD'),
      );
    });

    it('nunca negativo ni por encima de la base', () => {
      expect(percentPrice(100, 100, 'USD')).toBe(0);
      expect(percentPrice(100, 0, 'USD')).toBe(100);
      // Base con decimales en una moneda sin ellos: no sube por encima.
      expect(percentPrice(100.6, 0, 'COP')).toBe(100);
    });

    it('el precio por % del convenio sale redondeado en la moneda del plan', () => {
      expect(
        resolveItemPrice(
          ctx({
            agreement: percentAgreement({ percent: 15 }),
            catalogItem: {
              defaultPrice: 33333,
              category: null,
              allowDiscount: true,
            },
          }),
        ).price,
      ).toBe(28333);
    });
  });
});
