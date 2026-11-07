import { UnprocessableEntityException } from '@nestjs/common';
import {
  freezeReference,
  referenceRateCurrency,
  type ReferenceSnapshot,
  type SnapshotItem,
} from '../../../discounts/domain/reference-in-plan';
import type {
  ReferenceRateLookup,
  ReferenceRateSource,
} from '../../domain/ports/reference-rate-source.port';

/** 422 de DX-513-bis: la referencia está en otra moneda y no hay tasa de hoy. */
export const DISCOUNT_REFERENCE_RATE_MISSING_CODE =
  'DISCOUNT_REFERENCE_RATE_MISSING';

export function referenceRateMissingMessage(
  missing: { currency: string; date: string | null },
  referenceCurrency: string,
  planCurrency: string,
): string {
  const day = missing.date ? ` para el ${missing.date}` : ' para hoy';
  return `No hay tasa de ${missing.currency}${day}: el precio de catálogo está en ${referenceCurrency} y el plan en ${planCurrency}, y sin la tasa no se puede saber si el precio es un descuento. Regístrala en Ajustes › Tasa de cambio o usa una lista de precios en ${planCurrency}.`;
}

export function referenceRateMissing(
  missing: { currency: string; date: string | null },
  referenceCurrency: string,
  planCurrency: string,
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    code: DISCOUNT_REFERENCE_RATE_MISSING_CODE,
    message: referenceRateMissingMessage(
      missing,
      referenceCurrency,
      planCurrency,
    ),
    currency: missing.currency,
  });
}

/**
 * DX-513-bis §5.3: la tasa que hace falta para congelar la referencia del
 * ítem, o `null` si no hace falta (ítem libre, la referencia en la moneda del
 * plan o en una que no se sabe: el puerto de tasas ni se llama). Se pide ANTES
 * de la transacción, como la política.
 */
export async function referenceRateFor(
  rates: ReferenceRateSource,
  item: Pick<SnapshotItem, 'catalogPrice' | 'catalogCurrency' | 'priceSource'>,
  planCurrency: string,
): Promise<{ currency: string; lookup: ReferenceRateLookup } | null> {
  const currency = referenceRateCurrency(item, planCurrency);
  if (currency === null) return null;
  return { currency, lookup: await rates.rateFor(currency, planCurrency) };
}

/**
 * La foto de la referencia con la tasa ya pedida (`referenceRateFor`): 422
 * `DISCOUNT_REFERENCE_RATE_MISSING` si hacía falta y no la hay. Sin escribir
 * nada.
 */
export function freezeWithRate(
  item: Omit<SnapshotItem, 'referencePriceInPlan'>,
  planCurrency: string,
  asked: { currency: string; lookup: ReferenceRateLookup } | null,
): ReferenceSnapshot {
  if (asked === null) return freezeReference(item, planCurrency, 2, null);
  if (asked.lookup.kind === 'missing') {
    throw referenceRateMissing(asked.lookup, asked.currency, planCurrency);
  }
  return freezeReference(
    item,
    planCurrency,
    asked.lookup.toDigits,
    asked.lookup.rate,
  );
}
