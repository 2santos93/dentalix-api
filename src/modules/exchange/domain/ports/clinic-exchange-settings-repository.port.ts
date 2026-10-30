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
}

/** Ajustes de tasa de cambio de la clínica del contexto. */
export interface ClinicExchangeSettingsRepository {
  get(): Promise<ClinicExchangeSettings>;
  /**
   * Lee los ajustes con la fila de la clínica bloqueada, escribe los que
   * devuelve `next(before)` y devuelve el antes y el después, en la MISMA
   * transacción: dos ADMIN a la vez no dejan un «antes» que no fue real.
   */
  set(
    next: (before: ClinicExchangeSettings) => ClinicExchangeSettings,
  ): Promise<{ before: ClinicExchangeSettings; after: ClinicExchangeSettings }>;
  /** Zona IANA de la sede principal (la activa más antigua, R6). */
  principalTimeZone(): Promise<string>;
}
