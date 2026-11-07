import { UnprocessableEntityException } from '@nestjs/common';
import type { ClinicRole } from '@prisma/client';
import { EXCHANGE_RATE_SETTINGS_ROLES } from '../../../auth/presentation/guards/clinic-role-sets';
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

/** Lo que el mensaje de «sin tasa» necesita de la petición que falló. */
export interface MissingRate {
  currency: string;
  /** El día con el formato de la sede; null: «hoy». Nunca ISO. */
  dateLabel: string | null;
}

/**
 * El 422 en español: qué tasa falta, de qué día (con el formato de la sede) y
 * qué hacer según quién lo lee. Solo quien gestiona las tasas
 * (`EXCHANGE_RATE_SETTINGS_ROLES`, ADMIN) puede registrarla; al resto se le
 * dice que lo pida.
 */
export function referenceRateMissingMessage(
  missing: MissingRate,
  referenceCurrency: string,
  planCurrency: string,
  role: ClinicRole,
): string {
  const day = missing.dateLabel ? `para el ${missing.dateLabel}` : 'para hoy';
  const action = EXCHANGE_RATE_SETTINGS_ROLES.includes(role)
    ? `Regístrala en Ajustes › Tasa de cambio o usa una lista de precios en ${planCurrency}.`
    : `Pide a un administrador que registre la tasa del día o una lista de precios en ${planCurrency}.`;
  return `No hay tasa de ${missing.currency} ${day}: el precio de catálogo está en ${referenceCurrency} y el plan en ${planCurrency}, y sin la tasa no se puede saber si el precio es un descuento. ${action}`;
}

export function referenceRateMissing(
  missing: MissingRate,
  referenceCurrency: string,
  planCurrency: string,
  role: ClinicRole,
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    code: DISCOUNT_REFERENCE_RATE_MISSING_CODE,
    message: referenceRateMissingMessage(
      missing,
      referenceCurrency,
      planCurrency,
      role,
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
  role: ClinicRole,
): ReferenceSnapshot {
  if (asked === null) return freezeReference(item, planCurrency, 2, null);
  if (asked.lookup.kind === 'missing') {
    throw referenceRateMissing(
      asked.lookup,
      asked.currency,
      planCurrency,
      role,
    );
  }
  return freezeReference(
    item,
    planCurrency,
    asked.lookup.toDigits,
    asked.lookup.rate,
  );
}
