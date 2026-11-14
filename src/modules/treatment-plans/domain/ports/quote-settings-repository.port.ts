import type { QuoteSettings } from '../quote-validity';

export const QUOTE_SETTINGS_REPOSITORY = Symbol('QUOTE_SETTINGS_REPOSITORY');

/** Ajuste de validez del presupuesto de la clínica del contexto (DX-379). */
export interface QuoteSettingsRepository {
  /** `tenants.quoteValidityDays` de la clínica del contexto. */
  get(): Promise<QuoteSettings>;
  /**
   * Escribe el ajuste y devuelve el de antes y el de después, leídos y
   * escritos en la MISMA transacción con la fila de la clínica bloqueada: dos
   * ADMIN a la vez no dejan un «antes» que no fue real.
   */
  set(
    next: QuoteSettings,
  ): Promise<{ before: QuoteSettings; after: QuoteSettings }>;
}
