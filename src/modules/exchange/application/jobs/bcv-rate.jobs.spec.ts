import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { JobRegistry } from '../../../jobs/application/job-registry';
import type { JobQueue } from '../../../jobs/application/job-queue.service';
import type { JobsConfig } from '../../../jobs/infrastructure/jobs-config';
import { parseCron } from '../../../jobs/domain/cron';
import { makeBcvRates } from '../__fixtures__/in-memory-exchange-settings';
import type { RefreshBcvRateUseCase } from '../use-cases/refresh-bcv-rate.use-case';
import {
  BCV_REFRESH_JOB,
  BCV_REFRESH_SCHEDULES,
  BcvRateJobs,
} from './bcv-rate.jobs';

describe('BcvRateJobs (DX-585)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const setup = (
    options: {
      env?: Record<string, string>;
      workerEnabled?: boolean;
      now?: Date;
      repo?: ReturnType<typeof makeBcvRates>;
    } = {},
  ) => {
    const registry = new JobRegistry();
    const enqueue = jest.fn().mockResolvedValue({ created: true });
    const execute = jest.fn().mockResolvedValue({ kind: 'SAVED' });
    const repo = options.repo ?? makeBcvRates();
    const jobs = new BcvRateJobs(
      registry,
      { enqueue } as unknown as JobQueue,
      { execute } as unknown as RefreshBcvRateUseCase,
      {
        get: (key: string) => ({ NODE_ENV: 'production', ...options.env })[key],
      } as unknown as ConfigService,
      { workerEnabled: options.workerEnabled ?? true } as JobsConfig,
      repo,
      () => options.now ?? new Date('2026-11-23T18:30:00.000Z'),
    );
    jobs.onModuleInit();
    return { registry, enqueue, execute, jobs };
  };

  it('programa la consulta de lunes a viernes de 13:00 a 20:00 de Caracas (UTC−4)', () => {
    const { registry } = setup();
    expect(registry.schedules()).toEqual([
      expect.objectContaining({
        name: 'exchange.bcv-refresh.afternoon',
        cron: '0 17-23 * * 1-5',
        job: BCV_REFRESH_JOB,
        singleton: true,
      }),
      expect.objectContaining({
        name: 'exchange.bcv-refresh.evening',
        cron: '0 0 * * 2-6',
        job: BCV_REFRESH_JOB,
        singleton: true,
      }),
    ]);
    // Los ticks de un lunes: 13:00 … 19:00 de Caracas y las 20:00.
    const after = (cron: string, from: string) =>
      parseCron(cron).next(new Date(from)).toISOString();
    const [afternoon, evening] = BCV_REFRESH_SCHEDULES;
    expect(after(afternoon.cron, '2026-11-23T12:00:00Z')).toBe(
      '2026-11-23T17:00:00.000Z',
    );
    expect(after(afternoon.cron, '2026-11-23T23:00:00Z')).toBe(
      '2026-11-24T17:00:00.000Z',
    );
    expect(after(evening.cron, '2026-11-23T23:00:00Z')).toBe(
      '2026-11-24T00:00:00.000Z',
    );
    // Viernes 20:00 de Caracas = sábado 00:00 UTC; el sábado por la tarde, nada.
    expect(after(evening.cron, '2026-11-27T23:30:00Z')).toBe(
      '2026-11-28T00:00:00.000Z',
    );
    expect(after(afternoon.cron, '2026-11-28T00:30:00Z')).toBe(
      '2026-11-30T17:00:00.000Z',
    );
    expect(after(evening.cron, '2026-11-28T00:30:00Z')).toBe(
      '2026-12-01T00:00:00.000Z',
    );
  });

  it('el trabajo consulta el BCV', async () => {
    const { registry, execute } = setup();
    await registry.get(BCV_REFRESH_JOB)!.handle({}, {} as never);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('en los tests sin BCV_BASE_URL no consulta nada (nunca la red real)', async () => {
    const { registry, execute } = setup({ env: { NODE_ENV: 'test' } });
    await registry.get(BCV_REFRESH_JOB)!.handle({}, {} as never);
    expect(execute).not.toHaveBeenCalled();
  });

  it('en los tests con BCV_BASE_URL (servidor falso) sí consulta', async () => {
    const { registry, execute } = setup({
      env: { NODE_ENV: 'test', BCV_BASE_URL: 'http://127.0.0.1:9' },
    });
    await registry.get(BCV_REFRESH_JOB)!.handle({}, {} as never);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  describe('al arrancar el worker', () => {
    it('sin ninguna tasa guardada, encola una consulta', async () => {
      const { jobs, enqueue } = setup();
      await jobs.onApplicationBootstrap();
      expect(enqueue).toHaveBeenCalledWith(
        BCV_REFRESH_JOB,
        {},
        { idempotencyKey: 'bcv-startup:2026-11-23' },
      );
    });

    it('si la última se consultó ayer (Caracas), encola', async () => {
      const repo = makeBcvRates([
        // 2026-11-23T02:00Z = domingo 22, 22:00 en Caracas.
        {
          valueDate: '2026-11-23',
          usdVes: 1,
          eurVes: 1.1,
          fetchedAt: new Date('2026-11-23T02:00:00Z'),
        },
      ]);
      const { jobs, enqueue } = setup({ repo });
      expect(await jobs.enqueueIfMissingToday()).toBe(true);
      expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('si ya se consultó hoy, no encola', async () => {
      const repo = makeBcvRates([
        {
          valueDate: '2026-11-24',
          usdVes: 1,
          eurVes: 1.1,
          fetchedAt: new Date('2026-11-23T17:00:00Z'),
        },
      ]);
      const { jobs, enqueue } = setup({ repo });
      await jobs.onApplicationBootstrap();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('en la API (sin worker) o en los tests no encola', async () => {
      const api = setup({ workerEnabled: false });
      await api.jobs.onApplicationBootstrap();
      expect(api.enqueue).not.toHaveBeenCalled();
      const test = setup({ env: { NODE_ENV: 'test' } });
      await test.jobs.onApplicationBootstrap();
      expect(test.enqueue).not.toHaveBeenCalled();
    });

    it('un fallo al encolar no tumba el arranque', async () => {
      const { jobs, enqueue } = setup();
      enqueue.mockRejectedValue(new Error('BD caída'));
      await expect(jobs.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith({
        event: 'exchange.bcv_startup_enqueue_failed',
        error: 'Error',
      });
    });
  });
});
