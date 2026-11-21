import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { ExchangeRateSnapshot } from '../../domain/entities/exchange-rate-snapshot.entity';
import type { ClinicCurrencies } from '../../domain/clinic-currencies';
import type { HeaderLocation } from '../../domain/ports/clinic-currencies-repository.port';
import {
  ExchangeRateBudgetExceededError,
  ExchangeRateUnavailableError,
} from '../../domain/ports/exchange-rate-provider.port';
import type { ExchangeRateRepository } from '../../domain/ports/exchange-rate-repository.port';
import type { ExchangeRateSource } from '../../domain/exchange-rate-source';
import {
  makeBcvRates,
  makeClinicCurrencies,
  makeManualRates,
  makeSettings,
} from '../__fixtures__/in-memory-exchange-settings';
import {
  DEFAULT_PROVIDER_RATES_LIMITS,
  ProviderRatesGate,
} from '../provider-rates-gate';
import { GetExchangeHeaderUseCase } from './get-exchange-header.use-case';
import { GetRatesForDateUseCase } from './get-rates-for-date.use-case';

const TENANT = '58458458-4584-4584-8584-584584584584';
// 2026-11-21 02:00 UTC: en Caracas (UTC−4) aún es el 20.
const NOW = new Date('2026-11-21T02:00:00.000Z');
const TODAY_CARACAS = '2026-11-20';
const FETCHED_AT = new Date('2026-11-20T13:00:00.000Z');

function snapshotsRepo(
  byDate: Record<string, Record<string, number>>,
): ExchangeRateRepository & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    findByDate: (date) => {
      reads.push(date);
      return Promise.resolve(
        Object.entries(byDate[date] ?? {}).map(
          ([currency, rate]): ExchangeRateSnapshot => ({
            id: `${date}:${currency}`,
            date,
            currency,
            rate,
            fetchedAt: FETCHED_AT,
          }),
        ),
      );
    },
    upsertMany: (date, rates) => {
      byDate[date] = { ...(byDate[date] ?? {}), ...rates };
      return Promise.resolve();
    },
  };
}

interface Setup {
  currencies?: Partial<ClinicCurrencies>;
  location?: HeaderLocation | null;
  source?: ExchangeRateSource;
  manualRateMaxAgeDays?: number;
  snapshots?: Record<string, Record<string, number>>;
  manual?: Record<string, Record<string, number>>;
  texts?: Record<string, string>;
  fetchRates?: jest.Mock;
  /** DX-585: las tasas del BCV guardadas (con `source: 'BCV'`). */
  bcv?: Parameters<typeof makeBcvRates>[0];
}

function setup(options: Setup = {}) {
  const ctx = new TenantContextService();
  const currencies = makeClinicCurrencies(
    { [TENANT]: options.currencies ?? {} },
    ctx,
    {
      headerLocations: {
        [TENANT]:
          options.location === undefined
            ? { timeZone: 'America/Caracas', currency: 'VES' }
            : options.location,
      },
    },
  );
  const settings = makeSettings(
    options.source === 'MANUAL'
      ? {
          [TENANT]: {
            source: 'MANUAL',
            manualSince: '2026-01-01',
            manualRateMaxAgeDays: options.manualRateMaxAgeDays ?? 3,
          },
        }
      : options.source === 'BCV'
        ? { [TENANT]: 'BCV' }
        : {},
    ctx,
    {
      windows: {
        [TENANT]: {
          since: new Date('2026-01-01T00:00:00.000Z'),
          timeZones: ['America/Caracas'],
        },
      },
    },
  );
  const repo = snapshotsRepo(options.snapshots ?? {});
  const fetchRates =
    options.fetchRates ??
    jest.fn(() =>
      Promise.reject(new ExchangeRateUnavailableError('sin proveedor')),
    );
  const rates = new GetRatesForDateUseCase(
    repo,
    { fetchRates },
    settings,
    makeManualRates({ [TENANT]: options.manual ?? {} }, ctx),
    ctx,
    new ProviderRatesGate(DEFAULT_PROVIDER_RATES_LIMITS, () => NOW),
    () => NOW,
    undefined,
    makeBcvRates(options.bcv ?? []),
  );
  const useCase = new GetExchangeHeaderUseCase(
    currencies,
    {
      get: () => Promise.resolve(options.texts ?? {}),
      set: () => Promise.reject(new Error('no se usa')),
    },
    settings,
    repo,
    rates,
    () => NOW,
  );
  return {
    run: () => ctx.run(TENANT, () => useCase.execute()),
    fetchRates,
    repo,
  };
}

describe('GetExchangeHeaderUseCase (DX-584)', () => {
  it('USD+VES aceptadas, referencia de la sede (VES): «1 USD = 918,77 Bs.» con el texto propio y la hora de la tasa', async () => {
    const { run } = setup({
      currencies: { acceptedCurrencies: ['USD', 'VES'] },
      snapshots: { [TODAY_CARACAS]: { VES: 918.77, EUR: 0.92 } },
      texts: { VES: 'Bs.' },
    });
    await expect(run()).resolves.toEqual({
      visible: true,
      reference: 'VES',
      referenceLabel: 'Bs.',
      rates: [
        {
          currency: 'USD',
          perReference: 918.77,
          label: null,
          source: 'AUTOMATIC',
          date: TODAY_CARACAS,
          fetchedAt: FETCHED_AT.toISOString(),
          valueDate: null,
        },
      ],
      acceptedCurrencies: ['USD', 'VES'],
      updatedAt: NOW.toISOString(),
    });
  });

  it('EUR contra VES cruza vía USD; filas en el orden de la clínica', async () => {
    const { run } = setup({
      currencies: { acceptedCurrencies: ['EUR', 'VES', 'USD'] },
      snapshots: { [TODAY_CARACAS]: { VES: 918.77, EUR: 0.92 } },
    });
    const header = await run();
    expect(header.rates.map((r) => [r.currency, r.perReference])).toEqual([
      ['EUR', Number((918.77 / 0.92).toFixed(8))],
      ['USD', 918.77],
    ]);
  });

  it('la referencia de la clínica manda sobre la de la sede', async () => {
    const { run } = setup({
      currencies: {
        acceptedCurrencies: ['USD', 'VES'],
        rateReferenceCurrency: 'USD',
      },
      location: { timeZone: 'America/Caracas', currency: 'VES' },
      snapshots: { [TODAY_CARACAS]: { VES: 1000 } },
    });
    const header = await run();
    expect(header.reference).toBe('USD');
    expect(header.rates).toEqual([
      expect.objectContaining({ currency: 'VES', perReference: 0.001 }),
    ]);
  });

  it('sin tasa (proveedor caído): visible, fila con perReference null y sin fetchedAt; no lanza', async () => {
    const { run, fetchRates } = setup({
      currencies: { acceptedCurrencies: ['USD', 'VES'] },
    });
    const header = await run();
    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(header).toMatchObject({
      visible: true,
      rates: [
        {
          currency: 'USD',
          perReference: null,
          source: 'AUTOMATIC',
          date: TODAY_CARACAS,
          fetchedAt: null,
          valueDate: null,
        },
      ],
    });
  });

  it('presupuesto del proveedor agotado (SEC-054): fila sin tasa, no 429', async () => {
    const { run } = setup({
      currencies: { acceptedCurrencies: ['USD', 'VES'] },
      fetchRates: jest.fn(() =>
        Promise.reject(new ExchangeRateBudgetExceededError('CLINIC', 60)),
      ),
    });
    await expect(run()).resolves.toMatchObject({
      visible: true,
      rates: [{ perReference: null }],
    });
  });

  it('una moneda que el proveedor no trae sale sin tasa y la otra con la suya', async () => {
    const { run } = setup({
      currencies: { acceptedCurrencies: ['USD', 'GBP', 'VES'] },
      snapshots: { [TODAY_CARACAS]: { VES: 918.77 } },
    });
    const header = await run();
    expect(header.rates.map((r) => [r.currency, r.perReference])).toEqual([
      ['USD', 918.77],
      ['GBP', null],
    ]);
  });

  describe('MANUAL', () => {
    it('la tasa registrada hoy, sin fetchedAt y sin llamar al proveedor', async () => {
      const { run, fetchRates } = setup({
        source: 'MANUAL',
        currencies: { acceptedCurrencies: ['USD', 'VES'] },
        manual: { [TODAY_CARACAS]: { VES: 920 } },
      });
      await expect(run()).resolves.toMatchObject({
        visible: true,
        rates: [
          {
            currency: 'USD',
            perReference: 920,
            source: 'MANUAL',
            date: TODAY_CARACAS,
            fetchedAt: null,
            valueDate: null,
          },
        ],
      });
      expect(fetchRates).not.toHaveBeenCalled();
    });

    it('sin la de hoy, la última dentro del plazo (DX-384) con su día', async () => {
      const { run } = setup({
        source: 'MANUAL',
        manualRateMaxAgeDays: 3,
        currencies: { acceptedCurrencies: ['USD', 'VES'] },
        manual: { '2026-11-18': { VES: 900 } },
      });
      await expect(run()).resolves.toMatchObject({
        rates: [{ perReference: 900, date: '2026-11-18', source: 'MANUAL' }],
      });
    });

    it('fuera del plazo, sin tasa', async () => {
      const { run } = setup({
        source: 'MANUAL',
        manualRateMaxAgeDays: 1,
        currencies: { acceptedCurrencies: ['USD', 'VES'] },
        manual: { '2026-11-15': { VES: 900 } },
      });
      await expect(run()).resolves.toMatchObject({
        visible: true,
        rates: [{ perReference: null, date: TODAY_CARACAS, source: 'MANUAL' }],
      });
    });
  });

  describe('visible', () => {
    it('automático sin monedas aceptadas: oculto y sin leer tasas', async () => {
      const { run, fetchRates, repo } = setup();
      await expect(run()).resolves.toEqual({
        visible: false,
        reference: 'VES',
        referenceLabel: null,
        rates: [],
        acceptedCurrencies: [],
        updatedAt: NOW.toISOString(),
      });
      expect(fetchRates).not.toHaveBeenCalled();
      expect(repo.reads).toEqual([]);
    });

    it('automático con solo la moneda de referencia aceptada: oculto', async () => {
      const { run } = setup({ currencies: { acceptedCurrencies: ['VES'] } });
      await expect(run()).resolves.toMatchObject({ visible: false, rates: [] });
    });

    it('«Nunca» lo oculta aunque haya monedas', async () => {
      const { run, repo } = setup({
        currencies: {
          acceptedCurrencies: ['USD', 'VES'],
          showRateInHeader: false,
        },
        snapshots: { [TODAY_CARACAS]: { VES: 918.77 } },
      });
      await expect(run()).resolves.toMatchObject({
        visible: false,
        rates: [],
        acceptedCurrencies: ['USD', 'VES'],
      });
      expect(repo.reads).toEqual([]);
    });

    it('«Siempre» sin monedas aceptadas enseña la del USD', async () => {
      const { run } = setup({
        currencies: { showRateInHeader: true },
        snapshots: { [TODAY_CARACAS]: { VES: 918.77 } },
      });
      await expect(run()).resolves.toMatchObject({
        visible: true,
        rates: [{ currency: 'USD', perReference: 918.77 }],
      });
    });

    it('sin sede utilizable: oculto', async () => {
      const { run } = setup({
        currencies: { acceptedCurrencies: ['USD', 'VES'] },
        location: null,
      });
      await expect(run()).resolves.toMatchObject({
        visible: false,
        reference: null,
        rates: [],
      });
    });

    it('sede sin moneda y sin referencia de la clínica: oculto', async () => {
      const { run } = setup({
        currencies: { acceptedCurrencies: ['USD', 'VES'] },
        location: { timeZone: 'America/Caracas', currency: null },
      });
      await expect(run()).resolves.toMatchObject({
        visible: false,
        reference: null,
      });
    });
  });

  // DX-585: fuente BCV.
  describe('fuente BCV (DX-585)', () => {
    const BCV_FETCHED_AT = new Date('2026-11-19T20:00:00.000Z');
    // Hoy en Caracas es el viernes 20: rige la de fecha valor 20, aunque la
    // del lunes 23 ya esté publicada.
    const bcv = [
      {
        valueDate: '2026-11-20',
        usdVes: 918.7662,
        eurVes: 1011.17949056,
        fetchedAt: BCV_FETCHED_AT,
      },
      {
        valueDate: '2026-11-23',
        usdVes: 925,
        eurVes: 1020,
        fetchedAt: new Date('2026-11-20T20:00:00Z'),
      },
    ];

    it('USD contra VES: la del BCV, con su fecha valor y su hora de consulta, sin llamar al proveedor', async () => {
      const { run, fetchRates } = setup({
        source: 'BCV',
        bcv,
        currencies: { acceptedCurrencies: ['USD', 'VES'] },
        texts: { VES: 'Bs.' },
      });
      const header = await run();
      expect(header.rates).toEqual([
        {
          currency: 'USD',
          perReference: 918.7662,
          label: null,
          source: 'BCV',
          date: TODAY_CARACAS,
          fetchedAt: BCV_FETCHED_AT.toISOString(),
          valueDate: '2026-11-20',
        },
      ]);
      expect(fetchRates).not.toHaveBeenCalled();
    });

    it('EUR contra VES: Bs. por EUR del BCV (cruzado vía USD)', async () => {
      const { run } = setup({
        source: 'BCV',
        bcv,
        currencies: { acceptedCurrencies: ['EUR', 'VES'] },
      });
      const [row] = (await run()).rates;
      expect(row.currency).toBe('EUR');
      expect(row.perReference).toBeCloseTo(1011.17949056, 4);
      expect(row.valueDate).toBe('2026-11-20');
    });

    it('una moneda que no es del BCV contra USD sale del proveedor: sin fecha valor y con la hora del proveedor', async () => {
      const { run } = setup({
        source: 'BCV',
        bcv,
        currencies: {
          acceptedCurrencies: ['GBP', 'USD'],
          rateReferenceCurrency: 'USD',
        },
        snapshots: { [TODAY_CARACAS]: { GBP: 0.8, VES: 1 } },
      });
      expect((await run()).rates).toEqual([
        expect.objectContaining({
          currency: 'GBP',
          source: 'BCV',
          fetchedAt: FETCHED_AT.toISOString(),
          valueDate: null,
        }),
      ]);
    });

    it('sin tasa del BCV: «Sin tasa hoy» (null), nunca la del proveedor', async () => {
      const { run } = setup({
        source: 'BCV',
        currencies: { acceptedCurrencies: ['USD', 'VES'] },
        snapshots: { [TODAY_CARACAS]: { VES: 917.62 } },
      });
      expect((await run()).rates).toEqual([
        expect.objectContaining({
          perReference: null,
          source: 'BCV',
          fetchedAt: null,
          valueDate: null,
        }),
      ]);
    });
  });
});
