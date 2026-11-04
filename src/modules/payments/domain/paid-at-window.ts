import type { CivilPaidDay } from './ports/payment-repository.port';

/** Margen de un abono «en el futuro»: relojes desfasados y zonas por delante. */
export const PAID_AT_FUTURE_MARGIN_MS = 24 * 60 * 60 * 1000;

/** El desfase UTC más adelantado (Kiritimati, UTC+14). */
const EARLIEST_ZONE_OFFSET_MS = 14 * 60 * 60 * 1000;

export const PAID_AT_IN_FUTURE_MESSAGE =
  'La fecha del abono no puede estar más de 24 horas en el futuro.';

export const PAID_AT_AFTER_SITE_TODAY_MESSAGE =
  'La fecha del abono no puede ser posterior a hoy en la sede.';

/**
 * DX-054: un abono no se registra con fecha de más de 24 h por delante del
 * reloj del servidor (400). Un instante se compara tal cual; un día civil
 * (`YYYY-MM-DD`, DX-097) por su PRIMER instante posible en cualquier zona
 * (00:00 en UTC+14), así ningún día legítimo de una sede se rechaza por la
 * zona. Es el piso común: la aplican el abono suelto, el repartido y el del
 * saldo inicial. DX-075 lo afina para el día civil con
 * `isPaidAtAfterSiteToday` cuando se conoce la zona de la sede.
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

/**
 * DX-075: un abono con solo el día (`YYYY-MM-DD`) no puede ser posterior al
 * día civil de HOY en la sede donde se registra (400): «mañana» en la sede es
 * futuro aunque quede dentro de las 24 h de DX-054. `siteToday` es el día
 * civil de `now` en la zona de la sede, o `null` si la sede no tiene zona
 * (entonces solo rige la regla de 24 h). Un instante no se mira aquí: sigue
 * con la regla de 24 h.
 */
export function isPaidAtAfterSiteToday(
  paidAt: Date | CivilPaidDay,
  siteToday: string | null,
): boolean {
  if (paidAt instanceof Date || siteToday === null) return false;
  return paidAt.civilDate > siteToday;
}
