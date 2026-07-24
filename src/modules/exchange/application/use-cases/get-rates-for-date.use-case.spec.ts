import { BadRequestException } from '@nestjs/common';
import { GetRatesForDateUseCase } from './get-rates-for-date.use-case';
import { ExchangeRateRepository } from '../../domain/ports/exchange-rate-repository.port';
import { ExchangeRateProvider } from '../../domain/ports/exchange-rate-provider.port';
import { ExchangeRateSnapshot } from '../../domain/entities/exchange-rate-snapshot.entity';

/**
 * In-memory fake repo that actually stores what `upsertMany` writes, so
 * tests can prove real cache-then-fetch + idempotency behaviour (not just
 * that the methods were called).
 */
function makeInMemoryRepo(): ExchangeRateRepository & {
  seed(date: string, rates: Record<string, number>): void;
} {
  const store = new Map<string, Map<string, number>>();

  return {
    seed(date, rates) {
      const byCurrency = store.get(date) ?? new Map<string, number>();
      for (const [currency, rate] of Object.entries(rates)) {
        byCurrency.set(currency, rate);
      }
      store.set(date, byCurrency);
    },
    findByDate(date: string): Promise<ExchangeRateSnapshot[]> {
      const byCurrency = store.get(date);
      if (!byCurrency) {
        return Promise.resolve([]);
      }
      const snapshots: ExchangeRateSnapshot[] = Array.from(
        byCurrency.entries(),
      ).map(([currency, rate]) => ({
        id: `${date}:${currency}`,
        date,
        currency,
        rate,
        fetchedAt: new Date('2026-01-01T00:00:00.000Z'),
      }));
      return Promise.resolve(snapshots);
    },
    upsertMany(date: string, rates: Record<string, number>): Promise<void> {
      const byCurrency = store.get(date) ?? new Map<string, number>();
      for (const [currency, rate] of Object.entries(rates)) {
        byCurrency.set(currency, rate);
      }
      store.set(date, byCurrency);
      return Promise.resolve();
    },
  };
}

function makeProvider(
  fetchRates: ExchangeRateProvider['fetchRates'],
): ExchangeRateProvider {
  return { fetchRates };
}

describe('GetRatesForDateUseCase', () => {
  it('returns cached rates without calling the provider (cache hit)', async () => {
    const repo = makeInMemoryRepo();
    repo.seed('2026-07-20', { COP: 4000, EUR: 0.92 });
    const fetchRates = jest.fn();
    const provider = makeProvider(fetchRates);
    const uc = new GetRatesForDateUseCase(repo, provider);

    const result = await uc.execute('2026-07-20');

    expect(result).toEqual({
      base: 'USD',
      rates: { COP: 4000, EUR: 0.92 },
    });
    expect(fetchRates).not.toHaveBeenCalled();
  });

  it('fetches from the provider and persists on a cache miss', async () => {
    const repo = makeInMemoryRepo();
    const fetchRates = jest
      .fn()
      .mockResolvedValue({ base: 'USD', rates: { COP: 4100, EUR: 0.93 } });
    const provider = makeProvider(fetchRates);
    const uc = new GetRatesForDateUseCase(repo, provider);

    const result = await uc.execute('2026-07-21');

    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(fetchRates).toHaveBeenCalledWith('2026-07-21');
    expect(result).toEqual({
      base: 'USD',
      rates: { COP: 4100, EUR: 0.93 },
    });
    // Persisted, so a subsequent read of the same date sees it.
    const stored = await repo.findByDate('2026-07-21');
    expect(stored).toHaveLength(2);
  });

  it('does not re-fetch on a second call for the same date (idempotent cache)', async () => {
    const repo = makeInMemoryRepo();
    const fetchRates = jest
      .fn()
      .mockResolvedValue({ base: 'USD', rates: { COP: 4100 } });
    const provider = makeProvider(fetchRates);
    const uc = new GetRatesForDateUseCase(repo, provider);

    const first = await uc.execute('2026-07-22');
    const second = await uc.execute('2026-07-22');

    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it.each([
    '2026-7-1',
    '07-22-2026',
    '2026/07/22',
    'not-a-date',
    '',
    '2026-07-22T00:00:00Z',
  ])(
    'rejects an invalid date format (%s) without calling the provider',
    async (date) => {
      const repo = makeInMemoryRepo();
      const fetchRates = jest.fn();
      const provider = makeProvider(fetchRates);
      const uc = new GetRatesForDateUseCase(repo, provider);

      await expect(uc.execute(date)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fetchRates).not.toHaveBeenCalled();
    },
  );
});
