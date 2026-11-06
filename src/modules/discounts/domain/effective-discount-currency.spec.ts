import { ClinicRole, PriceSource } from '@prisma/client';
import { DEFAULT_DISCOUNT_POLICY } from './discount-policy';
import {
  checkEffectiveDiscount,
  discountReference,
  effectiveDiscount,
  referenceCurrency,
  referenceInOtherCurrency,
  type ItemReference,
} from './effective-discount';

/**
 * DX-513: una rebaja frente a una referencia en otra moneda CONOCIDA no es un
 * descuento. Plan en USD con el catálogo en VES (no cuenta); plan en VES con
 * el catálogo en VES (cuenta); `catalogCurrency` NULL (moneda desconocida:
 * cuenta como hoy, decisión de producto).
 */
describe('referencia del descuento según la moneda (DX-513)', () => {
  const catalog = (
    catalogCurrency: string | null,
    catalogPrice = 3600,
  ): ItemReference => ({
    catalogPrice,
    catalogCurrency,
    priceSource: PriceSource.CATALOG,
  });

  describe('discountReference', () => {
    it('plan en VES con el catálogo en VES: la referencia de siempre', () => {
      expect(discountReference(catalog('VES'), 'VES')).toBe(3600);
    });

    it('plan en USD con el catálogo en VES: sin referencia (no se resta)', () => {
      expect(discountReference(catalog('VES'), 'USD')).toBeNull();
    });

    it('catalogCurrency NULL (moneda desconocida): cuenta como hoy', () => {
      expect(discountReference(catalog(null), 'VES')).toBe(3600);
      expect(discountReference(catalog(null), 'USD')).toBe(3600);
      expect(referenceInOtherCurrency(catalog(null), 'USD')).toBe(false);
      expect(referenceInOtherCurrency(catalog('VES'), 'USD')).toBe(true);
      expect(referenceInOtherCurrency(catalog('VES'), 'VES')).toBe(false);
    });

    it('ítem anterior a DX-105 (priceSource null): manda la moneda del catálogo', () => {
      const legacy = { ...catalog('VES'), priceSource: null };
      expect(discountReference(legacy, 'VES')).toBe(3600);
      expect(discountReference(legacy, 'USD')).toBeNull();
      // Sin moneda (el relleno de DX-502 no la puso): sigue contando.
      expect(
        discountReference({ ...legacy, catalogCurrency: null }, 'USD'),
      ).toBe(3600);
    });

    it('lista de la sede o del convenio: siempre en la moneda del plan (DX-105), aunque el catálogo sea de otra o no se sepa', () => {
      for (const priceSource of [
        PriceSource.PRICE_LIST,
        PriceSource.AGREEMENT_PRICE_LIST,
      ]) {
        for (const catalogCurrency of ['VES', 'USD', null]) {
          const item = { catalogPrice: 80, catalogCurrency, priceSource };
          expect(referenceCurrency(item, 'USD')).toBe('USD');
          expect(discountReference(item, 'USD')).toBe(80);
        }
      }
    });

    it('convenio por %: sale del precio de catálogo, en su moneda', () => {
      const item = {
        catalogPrice: 3240,
        catalogCurrency: 'VES',
        priceSource: PriceSource.AGREEMENT_PERCENT,
      };
      expect(discountReference(item, 'VES')).toBe(3240);
      expect(discountReference(item, 'USD')).toBeNull();
    });

    it('ítem libre: sin referencia en ninguna moneda', () => {
      expect(
        discountReference(
          { catalogPrice: null, catalogCurrency: 'USD', priceSource: null },
          'USD',
        ),
      ).toBeNull();
    });
  });

  describe('tope y motivo con la referencia de cada moneda', () => {
    const check = (
      role: ClinicRole,
      ref: ItemReference,
      planCurrency: string,
      price: number,
      discount = 0,
    ) =>
      checkEffectiveDiscount(DEFAULT_DISCOUNT_POLICY, role, {
        catalogPrice: discountReference(ref, planCurrency),
        price,
        discount,
        reason: null,
        reasonNote: null,
      });

    it('plan en USD con el catálogo en VES: 80 USD frente a 3.600 VES no consume el tope ni pide motivo', () => {
      expect(check(ClinicRole.ASSISTANT, catalog('VES'), 'USD', 80)).toEqual({
        kind: 'ok',
      });
      expect(check(ClinicRole.ADMIN, catalog('VES'), 'USD', 80)).toEqual({
        kind: 'ok',
      });
      expect(
        effectiveDiscount({
          catalogPrice: discountReference(catalog('VES'), 'USD'),
          price: 80,
          discount: 0,
        }).total,
      ).toBe(0);
    });

    it('plan en VES con el catálogo en VES: igual que hoy (tope y motivo)', () => {
      expect(check(ClinicRole.DENTIST, catalog('VES'), 'VES', 1800)).toEqual({
        kind: 'over-cap',
        maxPercent: 10,
        priceReduction: true,
      });
      expect(check(ClinicRole.ADMIN, catalog('VES'), 'VES', 2880)).toEqual({
        kind: 'reason-required',
        thresholdPercent: 10,
        priceReduction: true,
      });
    });

    it('catalogCurrency NULL: cuenta como hoy (la asistente no puede bajarlo)', () => {
      expect(check(ClinicRole.ASSISTANT, catalog(null), 'USD', 1)).toEqual({
        kind: 'over-cap',
        maxPercent: 0,
        priceReduction: true,
      });
    });

    it('frontera: el precio igual al de catálogo no es descuento en ninguna moneda', () => {
      expect(check(ClinicRole.ASSISTANT, catalog('VES'), 'VES', 3600)).toEqual({
        kind: 'ok',
      });
      expect(check(ClinicRole.ASSISTANT, catalog('VES'), 'USD', 3600)).toEqual({
        kind: 'ok',
      });
      // Un céntimo por debajo, en la misma moneda, ya lo es.
      expect(
        check(ClinicRole.ASSISTANT, catalog('VES'), 'VES', 3599.99),
      ).toMatchObject({ kind: 'over-cap', maxPercent: 0 });
    });

    it('en otra moneda, el descuento propio (en la moneda del plan) sigue contando sobre el precio', () => {
      expect(check(ClinicRole.DENTIST, catalog('VES'), 'USD', 80, 20)).toEqual({
        kind: 'over-cap',
        maxPercent: 10,
        priceReduction: false,
      });
    });
  });
});
