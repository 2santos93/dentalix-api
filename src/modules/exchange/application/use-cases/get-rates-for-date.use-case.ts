import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { EXCHANGE_RATE_REPOSITORY } from '../../domain/ports/exchange-rate-repository.port';
import type { ExchangeRateRepository } from '../../domain/ports/exchange-rate-repository.port';
import { EXCHANGE_RATE_PROVIDER } from '../../domain/ports/exchange-rate-provider.port';
import type { ExchangeRateProvider } from '../../domain/ports/exchange-rate-provider.port';
import { ExchangeRateSnapshot } from '../../domain/entities/exchange-rate-snapshot.entity';

// YYYY-MM-DD only. Guards the date before it ever reaches the repository
// query or (on a cache miss) gets interpolated into the provider's URL —
// closes the "unsanitized date" note left from Task 1.
export const DATE_FORMAT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateFormat(date: unknown): date is string {
  return typeof date === 'string' && DATE_FORMAT_PATTERN.test(date);
}

export interface RatesForDate {
  base: 'USD';
  rates: Record<string, number>;
}

function toRatesRecord(
  snapshots: ExchangeRateSnapshot[],
): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const snapshot of snapshots) {
    rates[snapshot.currency] = snapshot.rate;
  }
  return rates;
}

/**
 * Cache-then-fetch: reads the day's rates from the DB snapshot first; only
 * calls the external provider (and persists the result) on a cache miss.
 * Re-invoking for the same date after a miss is a hit — no duplicate fetch,
 * no duplicate rows (repo.upsertMany is idempotent on `@@unique([date,
 * currency])`).
 */
@Injectable()
export class GetRatesForDateUseCase {
  constructor(
    @Inject(EXCHANGE_RATE_REPOSITORY)
    private readonly repo: ExchangeRateRepository,
    @Inject(EXCHANGE_RATE_PROVIDER)
    private readonly provider: ExchangeRateProvider,
  ) {}

  async execute(date: string): Promise<RatesForDate> {
    if (!isValidDateFormat(date)) {
      throw new BadRequestException('date must match YYYY-MM-DD');
    }

    const cached = await this.repo.findByDate(date);
    if (cached.length > 0) {
      return { base: 'USD', rates: toRatesRecord(cached) };
    }

    const fetched = await this.provider.fetchRates(date);
    await this.repo.upsertMany(date, fetched.rates);
    return { base: 'USD', rates: fetched.rates };
  }
}
