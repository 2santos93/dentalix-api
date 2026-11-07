import { PriceSource } from '@prisma/client';
import {
  freezeReference,
  referenceInPlan,
  referenceRateCurrency,
  type FrozenReferenceRate,
  type SnapshotItem,
} from './reference-in-plan';

// DX-513-bis §5.2/§5.3: la referencia de la rebaja en la moneda del plan. Con
// foto (`referencePriceInPlan`), la foto; sin ella (ítem anterior), la regla
// de DX-513 tal cual.
const RATE_880: FrozenReferenceRate = {
  fromPerBase: 880,
  toPerBase: 1,
  source: 'MANUAL',
  rateDate: '2026-11-06',
};

const crown = (over: Partial<SnapshotItem> = {}): SnapshotItem => ({
  catalogPrice: 3600,
  basePrice: 3600,
  catalogCurrency: 'VES',
  priceSource: PriceSource.CATALOG,
  referencePriceInPlan: null,
  ...over,
});

describe('referenceInPlan (DX-513-bis, test 1)', () => {
  it('con foto: la referencia convertida, sea cual sea la moneda del catálogo', () => {
    expect(referenceInPlan(crown({ referencePriceInPlan: 4.09 }), 'USD')).toBe(
      4.09,
    );
  });

  it('sin foto, en la misma moneda: catalogPrice (como hoy)', () => {
    expect(referenceInPlan(crown(), 'VES')).toBe(3600);
  });

  it('sin foto, con otra moneda conocida: null (DX-513 para los anteriores)', () => {
    expect(referenceInPlan(crown(), 'USD')).toBeNull();
  });

  it('sin foto, con la moneda del catálogo NULL: cifras crudas (como hoy)', () => {
    expect(referenceInPlan(crown({ catalogCurrency: null }), 'USD')).toBe(3600);
  });

  it('ítem libre (sin catalogPrice): null', () => {
    expect(referenceInPlan(crown({ catalogPrice: null }), 'USD')).toBeNull();
  });
});

describe('referenceRateCurrency', () => {
  it('pide tasa solo con una referencia en otra moneda conocida', () => {
    expect(referenceRateCurrency(crown(), 'USD')).toBe('VES');
    expect(referenceRateCurrency(crown(), 'VES')).toBeNull();
    expect(
      referenceRateCurrency(crown({ catalogCurrency: null }), 'USD'),
    ).toBeNull();
    expect(
      referenceRateCurrency(crown({ catalogPrice: null }), 'USD'),
    ).toBeNull();
  });

  it('una lista de la sede está en la moneda del plan: sin tasa aunque el catálogo sea otra', () => {
    expect(
      referenceRateCurrency(
        crown({ priceSource: PriceSource.PRICE_LIST, catalogPrice: 4 }),
        'USD',
      ),
    ).toBeNull();
    expect(
      referenceRateCurrency(
        crown({
          priceSource: PriceSource.AGREEMENT_PRICE_LIST,
          catalogPrice: 4,
        }),
        'USD',
      ),
    ).toBeNull();
  });
});

describe('freezeReference (DX-513-bis §5.3, test 2)', () => {
  it('catálogo VES y plan USD a 880: la referencia es 4,09 USD y la tasa queda en la foto', () => {
    expect(freezeReference(crown(), 'USD', 2, RATE_880)).toEqual({
      referenceCurrency: 'VES',
      referencePriceInPlan: 4.09,
      basePriceInPlan: 4.09,
      referenceRate: RATE_880,
    });
  });

  it('catálogo USD y plan VES a 880: 4,50 USD son 3.960,00 Bs.', () => {
    expect(
      freezeReference(
        crown({ catalogPrice: 4.5, basePrice: 4.5, catalogCurrency: 'USD' }),
        'VES',
        2,
        { ...RATE_880, fromPerBase: 1, toPerBase: 880 },
      ),
    ).toMatchObject({ referencePriceInPlan: 3960, basePriceInPlan: 3960 });
  });

  it('EUR ↔ VES cruzada: 3.600 Bs. son 3,76 € (VES 880, EUR 0,92)', () => {
    expect(
      freezeReference(crown(), 'EUR', 2, {
        ...RATE_880,
        toPerBase: 0.92,
      }).referencePriceInPlan,
    ).toBe(3.76);
  });

  it('moneda de 0 dígitos: una referencia de 1.234,5 se congela en 1.235', () => {
    expect(
      freezeReference(
        crown({ catalogPrice: 1, basePrice: 1, catalogCurrency: 'USD' }),
        'CLP',
        0,
        { ...RATE_880, fromPerBase: 1, toPerBase: 1234.5 },
      ).referencePriceInPlan,
    ).toBe(1235);
  });

  it('AGREEMENT_PERCENT entre monedas: base y referencia convertidas con la misma tasa', () => {
    expect(
      freezeReference(
        crown({
          priceSource: PriceSource.AGREEMENT_PERCENT,
          catalogPrice: 3240,
        }),
        'USD',
        2,
        RATE_880,
      ),
    ).toMatchObject({ referencePriceInPlan: 3.68, basePriceInPlan: 4.09 });
  });

  it('misma moneda: la foto es catalogPrice y basePrice tal cual, sin tasa', () => {
    expect(freezeReference(crown(), 'VES', 2, null)).toEqual({
      referenceCurrency: 'VES',
      referencePriceInPlan: 3600,
      basePriceInPlan: 3600,
      referenceRate: null,
    });
  });

  it('moneda del catálogo NULL: la foto copia las cifras (cuentan como hoy), sin tasa', () => {
    expect(
      freezeReference(crown({ catalogCurrency: null }), 'USD', 2, null),
    ).toEqual({
      referenceCurrency: null,
      referencePriceInPlan: 3600,
      basePriceInPlan: 3600,
      referenceRate: null,
    });
  });

  it('lista de la sede en USD con el catálogo en VES: referencia en USD sin tasa; la base (VES) no se pasa a USD', () => {
    expect(
      freezeReference(
        crown({ priceSource: PriceSource.PRICE_LIST, catalogPrice: 4 }),
        'USD',
        2,
        null,
      ),
    ).toEqual({
      referenceCurrency: 'USD',
      referencePriceInPlan: 4,
      basePriceInPlan: null,
      referenceRate: null,
    });
  });

  it('ítem libre: sin foto', () => {
    expect(
      freezeReference(crown({ catalogPrice: null }), 'USD', 2, null),
    ).toEqual({
      referenceCurrency: null,
      referencePriceInPlan: null,
      basePriceInPlan: null,
      referenceRate: null,
    });
  });

  it('otra moneda conocida sin tasa: error de programación (el caso de uso responde 422 antes)', () => {
    expect(() => freezeReference(crown(), 'USD', 2, null)).toThrow(/sin tasa/);
  });
});
