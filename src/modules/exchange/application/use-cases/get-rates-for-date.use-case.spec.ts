import { BadRequestException } from '@nestjs/common';
import { GetRatesForDateUseCase } from './get-rates-for-date.use-case';
import { ExchangeRateRepository } from '../../domain/ports/exchange-rate-repository.port';
import {
  ExchangeRateBudgetExceededError,
  ExchangeRateProvider,
  ExchangeRateUnavailableError,
} from '../../domain/ports/exchange-rate-provider.port';
import {
  DEFAULT_PROVIDER_RATES_LIMITS,
  ProviderRatesGate,
} from '../provider-rates-gate';
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

    it('un día anterior al inicio usa la tasa automática (la guardada)', async () => {
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

  // SEC-054: la cuota del proveedor es una sola para toda la plataforma.
  describe('cuota del proveedor (SEC-054)', () => {
    const A = '33333333-3333-4333-8333-333333333333';
    const M = '44444444-4444-4444-8444-444444444444';
    // 2026-10-30 12:00 UTC; en Pacific/Kiritimati (UTC+14) ya es el 31.
    const NOW = new Date('2026-10-30T12:00:00.000Z');

    function setup(
      options: {
        fetchRates?: ExchangeRateProvider['fetchRates'];
        clinicLimit?: number;
        timeZones?: string[];
      } = {},
    ) {
      const repo = makeInMemoryRepo();
      repo.seed('2020-01-02', { COP: 3200 });
      const fetchRates = jest.fn(
        options.fetchRates ??
          ((date: string) =>
            Promise.resolve({
              base: 'USD' as const,
              rates: { COP: 4000 + date.length },
            })),
      );
      const tenantContext = new TenantContextService();
      const clock = () => NOW;
      const gate = new ProviderRatesGate(
        {
          ...DEFAULT_PROVIDER_RATES_LIMITS,
          clinic: {
            limit: options.clinicLimit ?? 30,
            windowMs: 60 * 60_000,
          },
        },
        clock,
      );
      const window = {
        // Alta el 2026-09-01; su primer abono, anterior, el 2026-08-15.
        since: new Date('2026-08-15T15:00:00.000Z'),
        timeZones: options.timeZones ?? ['America/Bogota'],
      };
      const uc = new GetRatesForDateUseCase(
        repo,
        makeProvider(fetchRates),
        makeSettings(
          { [M]: { source: 'MANUAL', manualSince: '2026-10-01' } },
          tenantContext,
          { windows: { [A]: window, [M]: window } },
        ),
        makeManualRates({}, tenantContext),
        tenantContext,
        gate,
        clock,
      );
      const asA = <T>(fn: () => Promise<T>) => tenantContext.run(A, fn);
      const asM = <T>(fn: () => Promise<T>) => tenantContext.run(M, fn);
      return { uc, repo, fetchRates, asA, asM };
    }

    async function badRequestBody(promise: Promise<unknown>) {
      const error = await promise.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      return (error as BadRequestException).getResponse() as {
        code: string;
        message: string;
      };
    }

    it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2025-02-29'])(
      'una fecha imposible (%s) es 400 en español y no llama a nadie',
      async (date) => {
        const { uc, fetchRates, asA } = setup();
        for (const read of [
          () => uc.forRequest(date),
          () => uc.execute(date),
        ]) {
          const body = await badRequestBody(asA(read));
          expect(body.code).toBe('EXCHANGE_RATE_DATE_INVALID');
          expect(body.message).toBe(
            'date debe ser un día que exista, con el formato AAAA-MM-DD.',
          );
        }
        expect(fetchRates).not.toHaveBeenCalled();
      },
    );

    it('con MANUAL, una fecha imposible también es 400 (no el día siguiente)', async () => {
      const { uc, asM } = setup();
      const body = await badRequestBody(asM(() => uc.forRequest('2026-02-30')));
      expect(body.code).toBe('EXCHANGE_RATE_DATE_INVALID');
    });

    it.each([
      ['un día futuro', '2026-10-31'],
      ['muy futuro', '2099-01-01'],
      ['antes del primer abono', '2026-08-14'],
      ['muy antiguo', '1999-01-04'],
    ])(
      'fuera de la ventana de la clínica (%s): 400 sin llamar al proveedor',
      async (_label, date) => {
        const { uc, fetchRates, asA } = setup();
        const body = await badRequestBody(asA(() => uc.forRequest(date)));
        expect(body).toMatchObject({
          code: 'EXCHANGE_RATE_DATE_OUT_OF_RANGE',
          message:
            'No hay tasa guardada de ese día y solo se piden al proveedor los días entre el 2026-08-15 (alta de la clínica o su primer abono) y hoy, 2026-10-30.',
        });
        expect(fetchRates).not.toHaveBeenCalled();
      },
    );

    it('los bordes de la ventana sí se piden', async () => {
      const { uc, fetchRates, asA } = setup();
      await asA(() => uc.forRequest('2026-08-15'));
      await asA(() => uc.forRequest('2026-10-30'));
      expect(fetchRates).toHaveBeenCalledTimes(2);
    });

    it('«hoy» es el de la sede más adelantada', async () => {
      const { uc, fetchRates, asA } = setup({
        timeZones: ['America/Bogota', 'Pacific/Kiritimati'],
      });
      await asA(() => uc.forRequest('2026-10-31'));
      expect(fetchRates).toHaveBeenCalledWith('2026-10-31');
    });

    it('un día ya guardado se sirve aunque quede fuera de la ventana', async () => {
      const { uc, fetchRates, asA } = setup();
      await expect(asA(() => uc.forRequest('2020-01-02'))).resolves.toEqual({
        base: 'USD',
        source: 'AUTOMATIC',
        rates: { COP: 3200 },
      });
      expect(fetchRates).not.toHaveBeenCalled();
    });

    it('la lectura interna (abonos, saldos) no aplica la ventana', async () => {
      const { uc, fetchRates, asA } = setup();
      await asA(() => uc.execute('2026-08-01'));
      expect(fetchRates).toHaveBeenCalledWith('2026-08-01');
    });

    it('caché negativa: un día que el proveedor no tiene no se vuelve a pedir', async () => {
      const { uc, fetchRates, asA } = setup({
        fetchRates: () =>
          Promise.reject(new ExchangeRateUnavailableError('HTTP 400')),
      });
      for (let i = 0; i < 5; i += 1) {
        await expect(
          asA(() => uc.forRequest('2026-10-01')),
        ).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
        await expect(
          asA(() => uc.execute('2026-10-01')),
        ).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
      }
      expect(fetchRates).toHaveBeenCalledTimes(1);
    });

    it('single-flight: peticiones simultáneas del mismo día, una llamada y un guardado', async () => {
      const { uc, repo, fetchRates, asA } = setup({ clinicLimit: 1 });
      const upsert = jest.spyOn(repo, 'upsertMany');
      const results = await asA(() =>
        Promise.all(
          Array.from({ length: 20 }, () => uc.forRequest('2026-10-01')),
        ),
      );
      expect(fetchRates).toHaveBeenCalledTimes(1);
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(new Set(results.map((r) => r.rates.COP)).size).toBe(1);
    });

    it('presupuesto de la clínica: superado, ExchangeRateBudgetExceededError sin llamar', async () => {
      const { uc, fetchRates, asA } = setup({ clinicLimit: 2 });
      await asA(() => uc.forRequest('2026-10-01'));
      await asA(() => uc.forRequest('2026-10-02'));
      await expect(
        asA(() => uc.forRequest('2026-10-03')),
      ).rejects.toBeInstanceOf(ExchangeRateBudgetExceededError);
      // Para quien convierte por dentro es «sin tasa».
      await expect(asA(() => uc.execute('2026-10-03'))).rejects.toBeInstanceOf(
        ExchangeRateUnavailableError,
      );
      expect(fetchRates).toHaveBeenCalledTimes(2);
      // Los días ya guardados siguen saliendo.
      await expect(
        asA(() => uc.forRequest('2026-10-01')),
      ).resolves.toBeDefined();
    });

    it('la precarga diaria queda fuera del presupuesto', async () => {
      const { uc, fetchRates, asA } = setup({ clinicLimit: 1 });
      await asA(() => uc.forRequest('2026-10-01'));
      await expect(
        asA(() => uc.prefetchProviderRates('2026-10-30')),
      ).resolves.toBeDefined();
      expect(fetchRates).toHaveBeenCalledTimes(2);
    });

    it('una clínica en MANUAL nunca llama al proveedor, ni por un día anterior al cambio', async () => {
      const { uc, fetchRates, asM } = setup();
      await expect(
        asM(() => uc.forRequest('2026-09-15')),
      ).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
      await expect(asM(() => uc.execute('2026-09-15'))).rejects.toBeInstanceOf(
        ExchangeRateUnavailableError,
      );
      await expect(asM(() => uc.forRequest('2026-10-15'))).resolves.toEqual({
        base: 'USD',
        source: 'MANUAL',
        rates: {},
      });
      // El día anterior al cambio que sí está guardado se sigue leyendo.
      await expect(asM(() => uc.execute('2020-01-02'))).resolves.toEqual({
        base: 'USD',
        source: 'AUTOMATIC',
        rates: { COP: 3200 },
      });
      expect(fetchRates).not.toHaveBeenCalled();
    });
  });
});
