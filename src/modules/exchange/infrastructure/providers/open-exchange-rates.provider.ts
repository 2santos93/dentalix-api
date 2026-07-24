import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ExchangeRateProvider,
  ExchangeRatesResult,
} from '../../domain/ports/exchange-rate-provider.port';

const DEFAULT_BASE_URL = 'https://openexchangerates.org/api';

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
 */
@Injectable()
export class OpenExchangeRatesProvider implements ExchangeRateProvider {
  constructor(private readonly config: ConfigService) {}

  async fetchRates(date: string): Promise<ExchangeRatesResult> {
    const appId = this.config.get<string>('EXCHANGE_APP_ID');
    if (!appId) {
      throw new Error(
        'EXCHANGE_APP_ID is not set — cannot call Open Exchange Rates. ' +
          'Set it in the environment (see .env.example); it is never hardcoded.',
      );
    }
    const baseUrl =
      this.config.get<string>('EXCHANGE_BASE_URL') ?? DEFAULT_BASE_URL;

    const url = `${baseUrl}/historical/${date}.json?app_id=${encodeURIComponent(appId)}&base=USD`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to reach Open Exchange Rates for date ${date}: ${message}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Open Exchange Rates returned ${response.status} for date ${date}: ${body}`,
      );
    }

    const payload: unknown = await response.json();
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('base' in payload) ||
      !('rates' in payload) ||
      (payload as { base: unknown }).base !== 'USD' ||
      typeof (payload as { rates: unknown }).rates !== 'object' ||
      (payload as { rates: unknown }).rates === null
    ) {
      throw new Error(
        `Unexpected Open Exchange Rates response shape for date ${date}`,
      );
    }

    return {
      base: 'USD',
      rates: (payload as { rates: Record<string, number> }).rates,
    };
  }
}
