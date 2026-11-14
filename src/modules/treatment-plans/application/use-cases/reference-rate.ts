import { UnprocessableEntityException } from '@nestjs/common';
import type { ClinicRole } from '@prisma/client';
import { EXCHANGE_RATE_SETTINGS_ROLES } from '../../../auth/presentation/guards/clinic-role-sets';
import {
  agreementBaseRateCurrency,
  freezeAgreementBase,
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

/**
 * El tipo del error (`TypeError`, `ExchangeRateProviderNotRespondingError`…),
 * nunca su mensaje (puede llevar datos de la conexión o del proveedor).
 */
function errorName(error: unknown): string {
  const name =
    typeof error === 'object' && error !== null
      ? (error as { name?: unknown }).name
      : undefined;
  return typeof name === 'string' ? name : typeof error;
}

/**
 * DX-513-ter §6.1: en el alta de un ítem de lista de CONVENIO con el catálogo
 * en otra moneda conocida, la base convertida a la moneda del plan con la
 * tasa del día (la misma fuente, día y redondeo que DX-513-bis), congelada en
 * la foto para que el informe mida la rebaja de convenio sin convertir nunca.
 *
 * Nunca bloquea el alta: sin tasa, o con CUALQUIER error al pedirla, la foto
 * queda como estaba (sin base) y el informe señala la fila «sin referencia
 * comparable». Un error que no es «sin tasa» se avisa con su nombre, nunca su
 * mensaje. En otro ítem (lista de la sede, catálogo, %, misma moneda) no se
 * pide tasa y la foto no cambia. Se llama ANTES de la transacción.
 */
export async function withAgreementBase(
  rates: ReferenceRateSource,
  item: Pick<SnapshotItem, 'priceSource' | 'basePrice' | 'catalogCurrency'>,
  planCurrency: string,
  reference: ReferenceSnapshot,
  warn: (message: string) => void,
): Promise<ReferenceSnapshot> {
  const currency = agreementBaseRateCurrency(item, planCurrency);
  if (currency === null || item.basePrice === null) return reference;
  let lookup: ReferenceRateLookup;
  try {
    lookup = await rates.rateFor(currency, planCurrency);
  } catch (error) {
    warn(
      `Sin tasa de ${currency} a ${planCurrency} para la base de un ítem de convenio (${errorName(error)}): se crea sin ella.`,
    );
    return reference;
  }
  if (lookup.kind === 'missing') return reference;
  return freezeAgreementBase(
    reference,
    item.basePrice,
    lookup.rate,
    lookup.toDigits,
  );
}
