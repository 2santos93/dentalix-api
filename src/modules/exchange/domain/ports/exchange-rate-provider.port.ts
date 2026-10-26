/**
 * El proveedor no pudo dar las tasas del día (sin credencial, sin red, HTTP
 * distinto de 2xx o respuesta con otra forma). Es el único fallo del proveedor
 * que los llamadores pueden tratar como «sin tasa»; cualquier otro error es un
 * fallo real y se propaga.
 */
export class ExchangeRateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeRateUnavailableError';
  }
}

export const EXCHANGE_RATE_PROVIDER = Symbol('EXCHANGE_RATE_PROVIDER');

/**
 * Result of fetching a day's exchange rates from an external market-data
 * source. Rates are always expressed as "units of `currency` per 1 USD"
 * (base USD) — see OpenExchangeRatesProvider for why base is fixed to USD.
 */
export interface ExchangeRatesResult {
  base: 'USD';
  rates: Record<string, number>;
}

/**
 * Port for a historical exchange-rate data source. Implementations do ONLY
 * fetch + parse — no caching, no DB access, no business logic (that lives in
 * the GetRatesForDate / ConvertAmount use cases, Task 2).
 */
export interface ExchangeRateProvider {
  /** @param date YYYY-MM-DD, the historical day to fetch rates for. */
  fetchRates(date: string): Promise<ExchangeRatesResult>;
}
