import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { ExchangeRateSource } from '../exchange-rate-source';

export const CLINIC_EXCHANGE_SETTINGS_REPOSITORY = Symbol(
  'CLINIC_EXCHANGE_SETTINGS_REPOSITORY',
);

/** Tasa de cambio de la clínica: `tenants.exchangeRateSource` y `manualExchangeRatesSince`. */
export interface ClinicExchangeSettings {
  source: ExchangeRateSource;
  /**
   * Día civil (YYYY-MM-DD) desde el que rige la fuente MANUAL: el de la sede
   * principal cuando la clínica pasó a MANUAL. `null` con AUTOMATIC. Los días
   * anteriores siguen con la tasa automática.
   */
  manualSince: string | null;
  /**
   * DX-384: con MANUAL, hasta cuántos días de antigüedad puede tener la
   * última tasa manual que sustituye a la del día de un abono (0 = solo la
   * del día exacto; de 0 a 30, 3 por defecto).
   */
  manualRateMaxAgeDays: number;
}

/**
 * SEC-054: desde cuándo puede necesitar la clínica una tasa del proveedor y
 * en qué zonas cuenta «hoy».
 */
export interface ClinicProviderWindow {
  /** Lo anterior entre el alta de la clínica y su primer abono vivo. */
  since: Date;
  /** Zonas IANA válidas de sus sedes no borradas (vacío si no tiene). */
  timeZones: string[];
}

/** Ajustes de tasa de cambio de la clínica del contexto. */
export interface ClinicExchangeSettingsRepository {
  get(): Promise<ClinicExchangeSettings>;
  /**
   * Lee los ajustes con la fila de la clínica bloqueada, escribe los que
   * devuelve `next(before)` y devuelve el antes y el después, en la MISMA
   * transacción: dos ADMIN a la vez no dejan un «antes» que no fue real.
   * DX-384: si cambia `manualRateMaxAgeDays`, el evento de auditoría con su
   * antes y después se escribe en esa misma transacción (el de la fuente lo
   * escribe el caso de uso, DX-374).
   */
  set(
    next: (before: ClinicExchangeSettings) => ClinicExchangeSettings,
    ctx: AuditRequestContext,
  ): Promise<{ before: ClinicExchangeSettings; after: ClinicExchangeSettings }>;
  /** Zona IANA de la sede principal (la activa más antigua, R6). */
  principalTimeZone(): Promise<string>;
  /** SEC-054: ver `ClinicProviderWindow`. */
  providerWindow(): Promise<ClinicProviderWindow>;
}
