import { BadRequestException } from '@nestjs/common';
import { GetRatesForDateUseCase } from './get-rates-for-date.use-case';
import { ExchangeRateRepository } from '../../domain/ports/exchange-rate-repository.port';
import { ExchangeRateProvider } from '../../domain/ports/exchange-rate-provider.port';
import { ExchangeRateSnapshot } from '../../domain/entities/exchange-rate-snapshot.entity';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  makeManualRates,
  makeSettings,
} from '../__fixtures__/in-memory-exchange-settings';

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

/**
 * Sin tenant en el contexto (la precarga diaria, un script) la lectura es la
 * del proveedor, como siempre: los casos de la caché van así.
 */
function makeUseCase(
  repo: ExchangeRateRepository,
  provider: ExchangeRateProvider,
): GetRatesForDateUseCase {
  return new GetRatesForDateUseCase(
    repo,
    provider,
    makeSettings({}),
    makeManualRates({}),
    new TenantContextService(),
  );
}

describe('GetRatesForDateUseCase', () => {
  it('returns cached rates without calling the provider (cache hit)', async () => {
    const repo = makeInMemoryRepo();
    repo.seed('2026-07-20', { COP: 4000, EUR: 0.92 });
    const fetchRates = jest.fn();
    const provider = makeProvider(fetchRates);
    const uc = makeUseCase(repo, provider);

    const result = await uc.execute('2026-07-20');

    expect(result).toEqual({
      base: 'USD',
      source: 'AUTOMATIC',
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
    const uc = makeUseCase(repo, provider);

    const result = await uc.execute('2026-07-21');

    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(fetchRates).toHaveBeenCalledWith('2026-07-21');
    expect(result).toEqual({
      base: 'USD',
      source: 'AUTOMATIC',
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
    const uc = makeUseCase(repo, provider);

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
      const uc = makeUseCase(repo, provider);

      await expect(uc.execute(date)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(fetchRates).not.toHaveBeenCalled();
    },
  );

  // DX-374: la fuente de la clínica del contexto decide de dónde sale la tasa.
  describe('fuente de la tasa de la clínica (DX-374)', () => {
    const DAY = '2026-10-30';
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';

    function setup() {
      const repo = makeInMemoryRepo();
      repo.seed(DAY, { COP: 4000, VES: 36.5 });
      const fetchRates = jest.fn();
      const tenantContext = new TenantContextService();
      const uc = new GetRatesForDateUseCase(
        repo,
        makeProvider(fetchRates),
        makeSettings({ [A]: 'AUTOMATIC', [B]: 'MANUAL' }, tenantContext),
        makeManualRates(
          { [B]: { [DAY]: { VES: 40.12345678 } } },
          tenantContext,
        ),
        tenantContext,
      );
      return { uc, fetchRates, tenantContext };
    }

    it('AUTOMATIC lee la caché del proveedor y lo dice en `source`', async () => {
      const { uc, tenantContext } = setup();
      await expect(
        tenantContext.run(A, () => uc.execute(DAY)),
      ).resolves.toEqual({
        base: 'USD',
        source: 'AUTOMATIC',
        rates: { COP: 4000, VES: 36.5 },
      });
    });

    it('MANUAL lee solo las tasas de la clínica de ese día', async () => {
      const { uc, tenantContext, fetchRates } = setup();
      await expect(
        tenantContext.run(B, () => uc.execute(DAY)),
      ).resolves.toEqual({
        base: 'USD',
        source: 'MANUAL',
        rates: { VES: 40.12345678 },
      });
      expect(fetchRates).not.toHaveBeenCalled();
    });

    it('dos clínicas con fuentes distintas el mismo día leen tasas distintas', async () => {
      const { uc, tenantContext } = setup();
      const [a, b] = await Promise.all([
        tenantContext.run(A, () => uc.execute(DAY)),
        tenantContext.run(B, () => uc.execute(DAY)),
      ]);
      expect(a.rates.VES).toBe(36.5);
      expect(b.rates.VES).toBe(40.12345678);
    });

    it('MANUAL sin tasa del día: `rates` vacío y NUNCA llama al proveedor', async () => {
      const { uc, tenantContext, fetchRates } = setup();
      await expect(
        tenantContext.run(B, () => uc.execute('2026-10-29')),
      ).resolves.toEqual({ base: 'USD', source: 'MANUAL', rates: {} });
      expect(fetchRates).not.toHaveBeenCalled();
    });

    it('providerRates ignora la fuente de la clínica (precarga diaria)', async () => {
      const { uc, tenantContext } = setup();
      await expect(
        tenantContext.run(B, () => uc.providerRates(DAY)),
      ).resolves.toEqual({ COP: 4000, VES: 36.5 });
    });
  });

  // Revisión de DX-374: la fuente MANUAL rige desde el día en que se eligió;
  // los días anteriores siguen con la tasa automática (no cambian los saldos
  // de antes del cambio).
  describe('día de inicio de la tasa manual', () => {
    const SINCE = '2026-10-30';
    const C = '88888888-8888-4888-8888-888888888888';

    function setup() {
      const repo = makeInMemoryRepo();
      repo.seed('2026-10-29', { VES: 35 });
      repo.seed(SINCE, { VES: 36.5 });
      const fetchRates = jest.fn();
      const tenantContext = new TenantContextService();
      const settings = makeSettings(
        { [C]: { source: 'MANUAL', manualSince: SINCE } },
        tenantContext,
      );
      const uc = new GetRatesForDateUseCase(
        repo,
        makeProvider(fetchRates),
        settings,
        makeManualRates({ [C]: { [SINCE]: { VES: 40 } } }, tenantContext),
        tenantContext,
      );
      return { uc, fetchRates, tenantContext, settings };
    }

    it('un día anterior al inicio usa la tasa automática', async () => {
      const { uc, tenantContext } = setup();
      await expect(
        tenantContext.run(C, () => uc.execute('2026-10-29')),
      ).resolves.toEqual({
        base: 'USD',
        source: 'AUTOMATIC',
        rates: { VES: 35 },
      });
    });

    it('el día de inicio y los siguientes usan la manual', async () => {
      const { uc, tenantContext, fetchRates } = setup();
      await expect(
        tenantContext.run(C, () => uc.execute(SINCE)),
      ).resolves.toEqual({ base: 'USD', source: 'MANUAL', rates: { VES: 40 } });
      await expect(
        tenantContext.run(C, () => uc.execute('2026-10-31')),
      ).resolves.toEqual({ base: 'USD', source: 'MANUAL', rates: {} });
      expect(fetchRates).not.toHaveBeenCalled();
    });

    it('memoized() lee los ajustes una vez y cada día una vez, con el mismo resultado', async () => {
      const { uc, tenantContext, settings } = setup();
      const findSpy = jest.fn();
      const lookup = tenantContext.run(C, () => uc.memoized());
      const results = await tenantContext.run(C, () =>
        Promise.all(
          ['2026-10-29', SINCE, '2026-10-29', SINCE].map((d) => {
            findSpy(d);
            return lookup(d);
          }),
        ),
      );
      expect(results.map((r) => r.source)).toEqual([
        'AUTOMATIC',
        'MANUAL',
        'AUTOMATIC',
        'MANUAL',
      ]);
      expect(settings.reads()).toBe(1);
      expect(results[0]).toBe(results[2]);
    });
  });
});
