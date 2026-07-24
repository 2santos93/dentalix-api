import { BadRequestException } from '@nestjs/common';
import { ConvertAmountUseCase } from './convert-amount.use-case';
import { GetRatesForDateUseCase } from './get-rates-for-date.use-case';
import { ExchangeRateRepository } from '../../domain/ports/exchange-rate-repository.port';
import { ExchangeRateProvider } from '../../domain/ports/exchange-rate-provider.port';
import { ExchangeRateSnapshot } from '../../domain/entities/exchange-rate-snapshot.entity';

const DATE = '2026-07-22';

/**
 * A repo pre-seeded with rates for DATE and a provider that throws if ever
 * called — proves ConvertAmount goes through the cache (GetRatesForDate's
 * cache-then-fetch), never hitting the external provider when a snapshot
 * already exists.
 */
function makeSeededUseCase(
  rates: Record<string, number>,
): ConvertAmountUseCase {
  const snapshots: ExchangeRateSnapshot[] = Object.entries(rates).map(
    ([currency, rate]) => ({
      id: `${DATE}:${currency}`,
      date: DATE,
      currency,
      rate,
      fetchedAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
  );

  const repo: ExchangeRateRepository = {
    findByDate: (date: string) =>
      Promise.resolve(date === DATE ? snapshots : []),
    upsertMany: () => Promise.reject(new Error('should not be called')),
  };
  const provider: ExchangeRateProvider = {
    fetchRates: () =>
      Promise.reject(new Error('provider should not be called on a cache hit')),
  };

  const getRatesForDate = new GetRatesForDateUseCase(repo, provider);
  return new ConvertAmountUseCase(getRatesForDate);
}

describe('ConvertAmountUseCase', () => {
  it('converts USD -> COP using the base rate directly', async () => {
    const uc = makeSeededUseCase({ COP: 4000 });

    const result = await uc.execute({
      amount: 100,
      from: 'USD',
      to: 'COP',
      date: DATE,
    });

    expect(result).toEqual({
      amount: 100,
      from: 'USD',
      to: 'COP',
      date: DATE,
      result: 400000,
      rateUsed: 4000,
    });
  });

  it('converts COP -> USD (division by the base rate)', async () => {
    const uc = makeSeededUseCase({ COP: 4000 });

    const result = await uc.execute({
      amount: 400000,
      from: 'COP',
      to: 'USD',
      date: DATE,
    });

    expect(result.result).toBe(100);
    expect(result.rateUsed).toBeCloseTo(0.00025, 10);
  });

  it('converts COP -> EUR via USD (cross-rate through the base)', async () => {
    const uc = makeSeededUseCase({ COP: 4000, EUR: 0.92 });

    const result = await uc.execute({
      amount: 4000,
      from: 'COP',
      to: 'EUR',
      date: DATE,
    });

    // 4000 COP -> 1 USD -> 0.92 EUR
    expect(result.result).toBe(0.92);
  });

  it('returns the amount unchanged when from === to, with rateUsed 1 (no rates lookup needed)', async () => {
    const uc = makeSeededUseCase({}); // empty: would 400 on any real lookup

    const result = await uc.execute({
      amount: 123.45,
      from: 'COP',
      to: 'COP',
      date: DATE,
    });

    expect(result).toEqual({
      amount: 123.45,
      from: 'COP',
      to: 'COP',
      date: DATE,
      result: 123.45,
      rateUsed: 1,
    });
  });

  it('rejects an unknown/unsupported currency with BadRequestException', async () => {
    const uc = makeSeededUseCase({ COP: 4000 });

    await expect(
      uc.execute({ amount: 10, from: 'USD', to: 'ZZZ', date: DATE }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      uc.execute({ amount: 10, from: 'ZZZ', to: 'USD', date: DATE }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([-1, -0.01, NaN, Infinity, -Infinity])(
    'rejects an invalid amount (%s) with BadRequestException',
    async (amount) => {
      const uc = makeSeededUseCase({ COP: 4000 });

      await expect(
        uc.execute({ amount, from: 'USD', to: 'COP', date: DATE }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each(['2026-7-22', '07-22-2026', 'not-a-date', ''])(
    'rejects an invalid date format (%s) with BadRequestException',
    async (date) => {
      const uc = makeSeededUseCase({ COP: 4000 });

      await expect(
        uc.execute({ amount: 10, from: 'USD', to: 'COP', date }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('rounds the result to 2 decimal places', async () => {
    const uc = makeSeededUseCase({ COP: 3891.23456 });

    const result = await uc.execute({
      amount: 10,
      from: 'USD',
      to: 'COP',
      date: DATE,
    });

    // 10 * 3891.23456 = 38912.3456 -> rounds to 38912.35
    expect(result.result).toBe(38912.35);
  });

  it('amount 0 does not divide by zero: rateUsed falls back to the unrounded from->to factor', async () => {
    const uc = makeSeededUseCase({ COP: 4000, EUR: 0.92 });

    const result = await uc.execute({
      amount: 0,
      from: 'COP',
      to: 'EUR',
      date: DATE,
    });

    expect(result.result).toBe(0);
    expect(result.rateUsed).toBeCloseTo(0.92 / 4000, 10);
  });

  it('does not touch the repository/provider at all when from === to (validated before any lookup)', async () => {
    const repo: ExchangeRateRepository = {
      findByDate: () => Promise.reject(new Error('should not be called')),
      upsertMany: () => Promise.reject(new Error('should not be called')),
    };
    const provider: ExchangeRateProvider = {
      fetchRates: () => Promise.reject(new Error('should not be called')),
    };
    const uc = new ConvertAmountUseCase(
      new GetRatesForDateUseCase(repo, provider),
    );

    const result = await uc.execute({
      amount: 50,
      from: 'USD',
      to: 'USD',
      date: DATE,
    });

    expect(result.result).toBe(50);
    expect(result.rateUsed).toBe(1);
  });
});
