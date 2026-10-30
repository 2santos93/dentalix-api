import { Logger } from '@nestjs/common';
import { JobRegistry } from '../../../jobs/application/job-registry';
import type { JobContext } from '../../../jobs/domain/job';
import type { GetRatesForDateUseCase } from '../use-cases/get-rates-for-date.use-case';
import {
  ExchangePrefetchJobs,
  PREFETCH_RATES_JOB,
  PREFETCH_RATES_SCHEDULE,
} from './exchange-prefetch.jobs';

const ctx: JobContext = {
  jobId: 'j',
  attempt: 1,
  maxAttempts: 5,
  tenantId: null,
  signal: new AbortController().signal,
};

function setup(appId: string | undefined) {
  const registry = new JobRegistry();
  const prefetchProviderRates = jest.fn(() => Promise.resolve({}));
  const jobs = new ExchangePrefetchJobs(
    registry,
    { prefetchProviderRates } as unknown as GetRatesForDateUseCase,
    { get: () => appId } as never,
    () => new Date('2026-10-16T00:05:00.000Z'),
  );
  jobs.onModuleInit();
  return { registry, prefetchProviderRates };
}

describe('ExchangePrefetchJobs (DX-085)', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });
  afterAll(() => {
    Logger.overrideLogger(true);
  });

  it('programa la precarga diaria de los tipos de cambio', () => {
    const { registry } = setup('app-id');
    expect(registry.schedules()).toEqual([
      {
        name: PREFETCH_RATES_SCHEDULE,
        cron: '5 0 * * *',
        job: PREFETCH_RATES_JOB,
        payload: {},
        // Reintenta con su propio backoff (no es un barrido): sin singleton.
        singleton: false,
      },
    ]);
  });

  it('precarga el día UTC de hoy con el caso de uso de la petición (cache-then-fetch)', async () => {
    const { registry, prefetchProviderRates } = setup('app-id');
    await registry.get(PREFETCH_RATES_JOB)!.handle({}, ctx);
    expect(prefetchProviderRates).toHaveBeenCalledWith('2026-10-16');
  });

  it('acepta un día concreto en el payload', async () => {
    const { registry, prefetchProviderRates } = setup('app-id');
    await registry.get(PREFETCH_RATES_JOB)!.handle({ date: '2026-10-15' }, ctx);
    expect(prefetchProviderRates).toHaveBeenCalledWith('2026-10-15');
  });

  it('sin EXCHANGE_APP_ID no llama al proveedor y no falla (no hay nada que reintentar)', async () => {
    const { registry, prefetchProviderRates } = setup('');
    await expect(
      registry.get(PREFETCH_RATES_JOB)!.handle({}, ctx),
    ).resolves.toBeUndefined();
    expect(prefetchProviderRates).not.toHaveBeenCalled();
  });

  it('un fallo del proveedor se propaga para que la cola lo reintente', async () => {
    const { registry, prefetchProviderRates } = setup('app-id');
    prefetchProviderRates.mockRejectedValueOnce(new Error('503'));
    await expect(
      registry.get(PREFETCH_RATES_JOB)!.handle({}, ctx),
    ).rejects.toThrow('503');
  });
});
