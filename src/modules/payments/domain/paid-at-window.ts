import type { CivilPaidDay } from './ports/payment-repository.port';

/** Margen de un abono «en el futuro»: relojes desfasados y zonas por delante. */
export const PAID_AT_FUTURE_MARGIN_MS = 24 * 60 * 60 * 1000;

/** El desfase UTC más adelantado (Kiritimati, UTC+14). */
const EARLIEST_ZONE_OFFSET_MS = 14 * 60 * 60 * 1000;

export const PAID_AT_IN_FUTURE_MESSAGE =
  'La fecha del abono no puede estar más de 24 horas en el futuro.';

/**
 * DX-054: un abono no se registra con fecha de más de 24 h por delante del
 * reloj del servidor (400). Un instante se compara tal cual; un día civil
 * (`YYYY-MM-DD`, DX-097) por su PRIMER instante posible en cualquier zona
 * (00:00 en UTC+14), así ningún «hoy» o «mañana» legítimo de una sede se
 * rechaza por la zona. Es la única definición de la regla: la aplican el
 * abono suelto, el repartido y el del saldo inicial.
 */
export function isPaidAtTooFarInFuture(
  paidAt: Date | CivilPaidDay,
  now: Date,
): boolean {
  const earliest =
    paidAt instanceof Date
      ? paidAt.getTime()
      : Date.parse(`${paidAt.civilDate}T00:00:00.000Z`) -
        EARLIEST_ZONE_OFFSET_MS;
  return earliest > now.getTime() + PAID_AT_FUTURE_MARGIN_MS;
}
