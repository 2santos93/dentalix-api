import type { CivilPaidDay } from './ports/payment-repository.port';
import { civilDateIn } from '../../../shared/time/civil-day';

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
 * saldo inicial. DX-075 y DX-110 lo afinan con el día civil de la sede
 * (`isPaidAtAfterSiteToday`) cuando se conoce su zona.
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

/** DX-110: el día civil de hoy en la sede del abono y la zona con que se mide. */
export interface SiteToday {
  /** Día civil (YYYY-MM-DD) de `now` en la zona de la sede. */
  today: string;
  /** Zona IANA de la sede donde se registra el abono. */
  timeZone: string;
}

/**
 * DX-075 y DX-110: un abono no puede caer en un día civil posterior al de
 * HOY en la sede donde se registra (400): «mañana» en la sede es futuro aunque
 * quede dentro de las 24 h de DX-054.
 * - Un día (`YYYY-MM-DD`) se compara tal cual (DX-075).
 * - Un instante se compara por SU día civil en la zona de la sede (DX-110):
 *   mañana a las 10:00 en Caracas es 400 aunque falten menos de 24 h; hoy a
 *   las 23:00 en Caracas pasa aunque en UTC ya sea mañana.
 * `site` es `null` si la sede no tiene zona válida: entonces solo rige la
 * regla de 24 h.
 */
export function isPaidAtAfterSiteToday(
  paidAt: Date | CivilPaidDay,
  site: SiteToday | null,
): boolean {
  if (site === null) return false;
  const paidOn =
    paidAt instanceof Date
      ? civilDateIn(paidAt, site.timeZone)
      : paidAt.civilDate;
  return paidOn > site.today;
}
