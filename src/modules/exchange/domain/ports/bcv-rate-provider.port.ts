import type { BcvRateSnapshot } from '../bcv-rate';

export const BCV_RATE_PROVIDER = Symbol('BCV_RATE_PROVIDER');

/**
 * DX-585: de dónde se lee la tasa oficial del BCV que está publicada ahora
 * (la última, con su «Fecha Valor»). Puerto propio, no el de Open Exchange
 * Rates: el BCV no da días históricos ni monedas fuera de VES/EUR. Solo
 * consulta y lee: sin caché, sin BD ni reglas (las pone
 * `RefreshBcvRateUseCase`).
 *
 * Si no hay tasa que dar (ni la oficial ni el respaldo contestan o se
 * entienden), lanza `ExchangeRateUnavailableError`: nunca inventa una tasa.
 */
export interface BcvRateProvider {
  fetchLatest(): Promise<BcvRateSnapshot>;
}
