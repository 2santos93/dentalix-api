import type { DentalCatalogRepository } from '../../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { PricingSource } from '../../../domain/ports/pricing-source.port';
import type { PricingContext } from '../../../domain/pricing/resolve-item-price';
import { REFERENCE_CURRENCY_DIGITS } from '../../../../../shared/money/__fixtures__/reference-currency-digits';

export const PRICING_TODAY = '2026-10-17';
export const PRICING_LOCATION_ID = 'loc-1';

/**
 * `PricingSource` de las specs: el ítem sale del catálogo de prueba y, salvo
 * que `extra` diga otra cosa, sin convenio ni lista de sede (la referencia es
 * el `defaultPrice`, como antes de DX-105).
 */
export function catalogPricing(
  catalog: Pick<DentalCatalogRepository, 'findById'>,
  extra: Partial<
    Omit<PricingContext, 'catalogItem' | 'planCurrency' | 'planRoundingDigits'>
  > = {},
): PricingSource & { calls: { patientId: string; currency: string }[] } {
  const calls: { patientId: string; currency: string }[] = [];
  return {
    calls,
    async contextFor(patientId, catalogItemId, planCurrency) {
      calls.push({ patientId, currency: planCurrency });
      const item = await catalog.findById(catalogItemId);
      if (!item) return null;
      return {
        catalogItem: {
          defaultPrice: item.defaultPrice,
          category: item.category,
          allowDiscount: item.allowDiscount,
        },
        planCurrency,
        planRoundingDigits:
          REFERENCE_CURRENCY_DIGITS.roundingDigits(planCurrency),
        // DX-502: el catálogo en la moneda del plan, salvo que `extra` diga otra.
        catalogCurrency: planCurrency,
        today: PRICING_TODAY,
        locationId: PRICING_LOCATION_ID,
        agreement: null,
        agreementListPrice: null,
        locationList: null,
        ...extra,
      };
    },
  };
}
