import { ClinicRole, DiscountReason } from '@prisma/client';
import { DEFAULT_DISCOUNT_POLICY } from './discount-policy';
import {
  PRICE_BELOW_CATALOG_NOTICE,
  checkEffectiveDiscount,
  effectiveDiscount,
  effectiveDiscountRises,
  priceBelowCatalogCapMessage,
  priceBelowCatalogReasonMessage,
} from './effective-discount';

describe('descuento efectivo de un ítem (SEC-041)', () => {
  describe('effectiveDiscount', () => {
    it('rebaja de precio + descuento sobre el precio de catálogo', () => {
      expect(
        effectiveDiscount({
          catalogPrice: 1_000_000,
          price: 900_000,
          discount: 50_000,
        }),
      ).toEqual({
        listPrice: 1_000_000,
        priceReduction: 100_000,
        itemDiscount: 50_000,
        total: 150_000,
      });
    });

    it('subir el precio por encima del catálogo no es un descuento negativo', () => {
      expect(
        effectiveDiscount({ catalogPrice: 1000, price: 1200, discount: 0 }),
      ).toEqual({
        listPrice: 1200,
        priceReduction: 0,
        itemDiscount: 0,
        total: 0,
      });
    });

    it('un ítem libre (sin precio de catálogo) solo cuenta su descuento', () => {
      expect(
        effectiveDiscount({ catalogPrice: null, price: 1, discount: 0 }),
      ).toEqual({ listPrice: 1, priceReduction: 0, itemDiscount: 0, total: 0 });
      expect(
        effectiveDiscount({ catalogPrice: null, price: 500, discount: 20 }),
      ).toMatchObject({ listPrice: 500, priceReduction: 0, total: 20 });
    });

    it('en céntimos exactos (sin errores de coma flotante)', () => {
      expect(
        effectiveDiscount({ catalogPrice: 0.3, price: 0.1, discount: 0.1 }),
      ).toEqual({
        listPrice: 0.3,
        priceReduction: 0.2,
        itemDiscount: 0.1,
        total: 0.3,
      });
    });
  });

  describe('checkEffectiveDiscount (tope del rol y umbral del motivo)', () => {
    const check = (
      role: ClinicRole,
      item: { catalogPrice: number | null; price: number; discount: number },
      reason: DiscountReason | null = null,
    ) =>
      checkEffectiveDiscount(DEFAULT_DISCOUNT_POLICY, role, {
        ...item,
        reason,
        reasonNote: null,
      });

    it('DENTIST (10 %) con el precio al 50 % del catálogo: supera su tope', () => {
      expect(
        check(ClinicRole.DENTIST, {
          catalogPrice: 1_000_000,
          price: 500_000,
          discount: 0,
        }),
      ).toEqual({ kind: 'over-cap', maxPercent: 10, priceReduction: true });
    });

    it('DENTIST con el precio al 95 %: dentro de su tope, sin motivo', () => {
      expect(
        check(ClinicRole.DENTIST, {
          catalogPrice: 1_000_000,
          price: 950_000,
          discount: 0,
        }),
      ).toEqual({ kind: 'ok' });
    });

    it('la rebaja y el descuento se suman: 5 % + 6 % supera el 10 %', () => {
      expect(
        check(ClinicRole.DENTIST, {
          catalogPrice: 1000,
          price: 950,
          discount: 57,
        }),
      ).toMatchObject({ kind: 'over-cap', priceReduction: true });
    });

    it('ASSISTANT (0 %): cualquier rebaja supera su tope; subir el precio no', () => {
      expect(
        check(ClinicRole.ASSISTANT, {
          catalogPrice: 1000,
          price: 999,
          discount: 0,
        }),
      ).toMatchObject({ kind: 'over-cap', maxPercent: 0 });
      expect(
        check(ClinicRole.ASSISTANT, {
          catalogPrice: 1000,
          price: 1500,
          discount: 0,
        }),
      ).toEqual({ kind: 'ok' });
    });

    it('por encima del umbral, la rebaja pide motivo; con motivo vale', () => {
      const item = { catalogPrice: 1000, price: 800, discount: 0 };
      expect(check(ClinicRole.ADMIN, item)).toEqual({
        kind: 'reason-required',
        thresholdPercent: 10,
        priceReduction: true,
      });
      expect(check(ClinicRole.ADMIN, item, DiscountReason.PROMOTION)).toEqual({
        kind: 'ok',
      });
    });

    it('ADMIN (100 %) puede fijar cualquier precio, incluso 0, con motivo', () => {
      expect(
        check(
          ClinicRole.ADMIN,
          { catalogPrice: 1000, price: 0, discount: 0 },
          DiscountReason.SERVICE_RECOVERY,
        ),
      ).toEqual({ kind: 'ok' });
    });

    it('un ítem libre con precio 1 no es un descuento', () => {
      expect(
        check(ClinicRole.ASSISTANT, {
          catalogPrice: null,
          price: 1,
          discount: 0,
        }),
      ).toEqual({ kind: 'ok' });
    });

    it('sin rebaja de precio, el resultado es el de DX-204 (sin marca de precio)', () => {
      expect(
        check(ClinicRole.DENTIST, {
          catalogPrice: 1000,
          price: 1000,
          discount: 150,
        }),
      ).toEqual({ kind: 'over-cap', maxPercent: 10, priceReduction: false });
    });
  });

  describe('effectiveDiscountRises', () => {
    it('bajar el precio por debajo del catálogo sube el % efectivo', () => {
      expect(
        effectiveDiscountRises(
          { catalogPrice: 1000, price: 1000, discount: 0 },
          { catalogPrice: 1000, price: 999, discount: 0 },
        ),
      ).toBe(true);
    });

    it('subir el precio nunca lo sube', () => {
      expect(
        effectiveDiscountRises(
          { catalogPrice: 1000, price: 800, discount: 50 },
          { catalogPrice: 1000, price: 900, discount: 50 },
        ),
      ).toBe(false);
      expect(
        effectiveDiscountRises(
          { catalogPrice: null, price: 1000, discount: 100 },
          { catalogPrice: null, price: 2000, discount: 100 },
        ),
      ).toBe(false);
    });

    it('bajar el precio de un ítem con descuento sube su %; sin descuento ni catálogo, no', () => {
      expect(
        effectiveDiscountRises(
          { catalogPrice: null, price: 1000, discount: 100 },
          { catalogPrice: null, price: 900, discount: 100 },
        ),
      ).toBe(true);
      expect(
        effectiveDiscountRises(
          { catalogPrice: null, price: 1000, discount: 0 },
          { catalogPrice: null, price: 1, discount: 0 },
        ),
      ).toBe(false);
    });
  });

  it('mensajes en español', () => {
    expect(PRICE_BELOW_CATALOG_NOTICE).toBe(
      'Precio por debajo del de catálogo: cuenta como descuento.',
    );
    expect(priceBelowCatalogCapMessage(10)).toBe(
      'Precio por debajo del de catálogo: cuenta como descuento. Tu rol permite hasta un 10 % de descuento por ítem.',
    );
    expect(priceBelowCatalogReasonMessage(10)).toBe(
      'Precio por debajo del de catálogo: cuenta como descuento y supera el 10 %. Indica el motivo del descuento.',
    );
  });
});
