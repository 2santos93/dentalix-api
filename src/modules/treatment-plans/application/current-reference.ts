import type { PricingSource } from '../domain/ports/pricing-source.port';
import {
  resolveItemPrice,
  type PricingContext,
  type ResolvedItemPrice,
} from '../domain/pricing/resolve-item-price';
import type {
  ReferenceRateLookup,
  ReferenceRateSource,
} from '../domain/ports/reference-rate-source.port';
import type { SnapshotItem } from '../../discounts/domain/reference-in-plan';
import { referenceRateFor } from './use-cases/reference-rate';

/** La tasa que pide la foto de la referencia (`referenceRateFor`). */
export interface AskedReferenceRate {
  currency: string;
  lookup: ReferenceRateLookup;
}

/**
 * El precio VIGENTE de un procedimiento para un paciente y la moneda de un
 * plan, como lo resolvería hoy el alta del ítem (DX-105, DX-502, DX-513-bis):
 * el contexto leído, el precio resuelto (convenio → lista de la sede →
 * catálogo), la moneda del catálogo que se congela con él y la tasa que pide
 * su foto (o `null` si no hace falta). Sin escribir nada.
 */
export interface CurrentReference {
  context: PricingContext;
  resolved: ResolvedItemPrice;
  /** DX-502: sin precio de catálogo no hay moneda que guardar. */
  catalogCurrency: string | null;
  /** Lo que la foto de la referencia necesita del precio resuelto. */
  priced: Omit<SnapshotItem, 'referencePriceInPlan'>;
  /** DX-513-bis: la tasa pedida; `lookup.kind === 'missing'` = sin tasa. */
  asked: AskedReferenceRate | null;
}

/**
 * DX-379 (D.1): UNA resolución del precio vigente para el alta del ítem, el
 * `GET price-quote` y la recotización, así «vista previa == recotizar ==
 * alta» por construcción. `null` si el procedimiento no existe en la clínica.
 * Solo lee (se llama antes de la transacción, como la política).
 */
export async function resolveCurrentReference(
  pricing: PricingSource,
  rates: ReferenceRateSource,
  patientId: string,
  catalogItemId: string,
  planCurrency: string,
): Promise<CurrentReference | null> {
  const context = await pricing.contextFor(
    patientId,
    catalogItemId,
    planCurrency,
  );
  if (!context) return null;
  const resolved = resolveItemPrice(context);
  const catalogCurrency =
    resolved.basePrice === null ? null : resolved.catalogCurrency;
  const priced = {
    catalogPrice: resolved.price,
    basePrice: resolved.basePrice,
    catalogCurrency,
    priceSource: resolved.source,
  };
  const asked = await referenceRateFor(rates, priced, planCurrency);
  return { context, resolved, catalogCurrency, priced, asked };
}

/**
 * Las tasas de una petición, pedidas una vez por par de monedas: una
 * recotización de varios ítems usa UNA tasa (la que guarda), no una por ítem.
 */
export function memoizedRates(rates: ReferenceRateSource): ReferenceRateSource {
  const seen = new Map<string, Promise<ReferenceRateLookup>>();
  return {
    rateFor(from, to) {
      const key = `${from}>${to}`;
      let lookup = seen.get(key);
      if (!lookup) {
        lookup = rates.rateFor(from, to);
        seen.set(key, lookup);
      }
      return lookup;
    },
  };
}
