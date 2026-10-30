import type { ExchangeRateSource } from '../exchange-rate-source';

export const CLINIC_EXCHANGE_SETTINGS_REPOSITORY = Symbol(
  'CLINIC_EXCHANGE_SETTINGS_REPOSITORY',
);

/** Fuente de la tasa de la clínica del contexto (`tenants.exchangeRateSource`). */
export interface ClinicExchangeSettingsRepository {
  getSource(): Promise<ExchangeRateSource>;
  /**
   * Escribe la fuente y devuelve la de antes y la de después, leídas y
   * escritas en la MISMA transacción con la fila de la clínica bloqueada: dos
   * ADMIN a la vez no dejan un «antes» que no fue real.
   */
  setSource(
    next: ExchangeRateSource,
  ): Promise<{ before: ExchangeRateSource; after: ExchangeRateSource }>;
}
