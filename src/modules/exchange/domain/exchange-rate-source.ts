import type { ExchangeRateSource } from '@prisma/client';

export type { ExchangeRateSource };

/**
 * DX-374: de dónde sale la tasa del día de una clínica. AUTOMATIC (por
 * defecto, lo de siempre): el proveedor, cacheado en `exchange_rate_snapshots`.
 * MANUAL: la tasa que registra el ADMIN para cada día y moneda; sin ella, la
 * moneda queda «sin tasa» y nunca se pide al proveedor.
 */
export const EXCHANGE_RATE_SOURCES: readonly ExchangeRateSource[] = [
  'AUTOMATIC',
  'MANUAL',
];

export const EXCHANGE_RATE_SOURCE_MESSAGE =
  'Elige de dónde sale la tasa: automática o manual.';

/** Moneda base de todas las tasas: su tasa siempre es 1 y no se registra. */
export const BASE_CURRENCY = 'USD';

/**
 * Tope de una tasa manual: 7 enteros y 8 decimales. Cabe en `Decimal(18,8)` y
 * en un `number` de JS sin perder dígitos (15 cifras significativas).
 */
export const MANUAL_RATE_MAX = 9_999_999.99999999;
export const MANUAL_RATE_MAX_DECIMALS = 8;

export const MANUAL_RATE_MESSAGE =
  'La tasa tiene que ser un número mayor que 0, con hasta 8 decimales y menos de 10.000.000.';
export const MANUAL_RATE_CURRENCY_MESSAGE =
  'Elige una moneda de la lista de monedas.';
export const MANUAL_RATE_BASE_CURRENCY_MESSAGE =
  'USD es la moneda base de las tasas: su tasa siempre es 1 y no se registra.';
export const MANUAL_RATE_DATE_MESSAGE =
  'La fecha de la tasa tiene que ser un día válido con el formato AAAA-MM-DD.';
export const MANUAL_RATE_FUTURE_DATE_MESSAGE =
  'No se puede registrar la tasa de un día que aún no ha llegado en la sede.';
export const MANUAL_RATE_DUPLICATE_MESSAGE =
  'Ya hay una tasa registrada para esa moneda en ese día. Si ningún abono la usó, corrígela en la lista.';
/** DX-375: una tasa manual que ya congeló algún abono no se cambia. */
export const MANUAL_RATE_IN_USE_MESSAGE =
  'Esta tasa ya la usa al menos un abono y no se puede cambiar: el saldo de esos abonos se calculó con ella.';
export const MANUAL_RATE_NOT_FOUND_MESSAGE =
  'No encontramos esa tasa de cambio en la clínica.';
export const MANUAL_RATE_NOT_A_MEMBER_MESSAGE =
  'Solo un miembro de la clínica puede registrar una tasa de cambio.';

/** Lista de las últimas tasas: por defecto y tope de filas. */
export const MANUAL_RATES_LIST_DEFAULT = 30;
export const MANUAL_RATES_LIST_MAX = 100;
