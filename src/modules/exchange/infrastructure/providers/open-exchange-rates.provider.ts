import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ExchangeRateProvider,
  ExchangeRateUnavailableError,
  ExchangeRatesResult,
} from '../../domain/ports/exchange-rate-provider.port';

const DEFAULT_BASE_URL = 'https://openexchangerates.org/api';

/** SEC-054 / BE-004: tiempo máximo de la llamada entera (cabeceras y cuerpo). */
export const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * HTTP client for Open Exchange Rates (https://openexchangerates.org).
 *
 * Historical endpoint: `GET {base}/historical/{date}.json?app_id=...&base=USD`.
 *
 * Note on `base=USD`: OER's free ("Developer") plan can only quote rates
 * against USD — requesting any other `base` currency is a paid-plan feature
 * and returns a 403. So this provider always requests `base=USD` and returns
 * `{ base: 'USD', rates }` as-is; converting to a non-USD base (if ever
 * needed) is the caller's job (ConvertAmount, Task 2), not this provider's.
 *
 * This class does ONLY fetch + parse: no caching, no DB, no business logic.
 * SEC-054: la llamada se corta a los 10 s y los errores nunca llevan el
 * cuerpo de la respuesta del proveedor (solo el estado HTTP).
 */
@Injectable()
export class OpenExchangeRatesProvider implements ExchangeRateProvider {
  constructor(private readonly config: ConfigService) {}

  async fetchRates(date: string): Promise<ExchangeRatesResult> {
    const appId = this.config.get<string>('EXCHANGE_APP_ID');
    if (!appId) {
      throw new ExchangeRateUnavailableError(
        'EXCHANGE_APP_ID is not set — cannot call Open Exchange Rates. ' +
          'Set it in the environment (see .env.example); it is never hardcoded.',
      );
    }
    const baseUrl =
      this.config.get<string>('EXCHANGE_BASE_URL') ?? DEFAULT_BASE_URL;

    const url = `${baseUrl}/historical/${encodeURIComponent(date)}.json?app_id=${encodeURIComponent(appId)}&base=USD`;

    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ExchangeRateUnavailableError(
        `Failed to reach Open Exchange Rates for date ${date}: ${errorName(error)}`,
      );
    }

    if (!response.ok) {
      // Sin leer el cuerpo: puede traer cualquier cosa y no debe llegar a
      // ningún mensaje. Se cancela para liberar la conexión.
      await response.body?.cancel().catch(() => undefined);
      throw new ExchangeRateUnavailableError(
        `Open Exchange Rates returned ${response.status} for date ${date}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ExchangeRateUnavailableError(
        `Unreadable Open Exchange Rates response for date ${date}: ${errorName(error)}`,
      );
    }
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('base' in payload) ||
      !('rates' in payload) ||
      (payload as { base: unknown }).base !== 'USD' ||
      typeof (payload as { rates: unknown }).rates !== 'object' ||
      (payload as { rates: unknown }).rates === null
    ) {
      throw new ExchangeRateUnavailableError(
        `Unexpected Open Exchange Rates response shape for date ${date}`,
      );
    }

    return {
      base: 'USD',
      rates: (payload as { rates: Record<string, number> }).rates,
    };
  }
}

/**
 * El tipo del error (`TimeoutError`, `TypeError`...), nunca su mensaje. El
 * del tiempo agotado es un `DOMException`, que no siempre es `instanceof Error`.
 */
function errorName(error: unknown): string {
  const name =
    typeof error === 'object' && error !== null
      ? (error as { name?: unknown }).name
      : undefined;
  return typeof name === 'string' ? name : typeof error;
}
