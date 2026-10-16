import { Logger } from '@nestjs/common';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { ClaimedJob } from '../domain/job';
import type { JobRepository } from '../domain/job-repository.port';
import type { JobsConfig } from '../infrastructure/jobs-config';
import { JobRegistry } from './job-registry';
import { JobWorker } from './job-worker.service';

const config: JobsConfig = {
  role: 'worker',
  workerEnabled: false,
  workerId: 'unit:1:00000000',
  pollIntervalMs: 100,
  concurrency: 4,
  leaseSeconds: 300,
  maxAttempts: 5,
  retryBaseMs: 1000,
  shutdownGraceMs: 5000,
  heartbeatMs: 10,
  retentionDays: 14,
};

function fakeRepo(queue: ClaimedJob[]) {
  const calls: string[] = [];
  const repo: JobRepository = {
    insert: jest.fn(),
    transactionTenant: jest.fn(),
    claim: jest.fn((names: string[], limit: number) =>
      Promise.resolve(
        queue.splice(0, limit).filter((j) => names.includes(j.name)),
      ),
    ),
    complete: jest.fn((id: string, attempts: number) => {
      calls.push(`complete ${id} ${attempts}`);
      return Promise.resolve(true);
    }),
    reschedule: jest.fn(
      (id: string, attempts: number, delayMs: number, error: string) => {
        calls.push(`reschedule ${id} ${attempts} ${delayMs} ${error}`);
        return Promise.resolve(true);
      },
    ),
    heartbeat: jest.fn(() => Promise.resolve(true)),
    fail: jest.fn((id: string, attempts: number, error: string) => {
      calls.push(`fail ${id} ${attempts} ${error}`);
      return Promise.resolve(true);
    }),
    syncSchedules: jest.fn(() => Promise.resolve()),
    fireDueSchedules: jest.fn(() => Promise.resolve(0)),
    listFailed: jest.fn(),
    purgeFinished: jest.fn(),
  };
  return { repo, calls };
}

const job = (over: Partial<ClaimedJob>): ClaimedJob => ({
  id: 'j1',
  name: 'unit.job',
  tenantId: null,
  payload: {},
  attempts: 1,
  maxAttempts: 3,
  ...over,
});

describe('JobWorker (unit)', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });
  afterAll(() => {
    Logger.overrideLogger(true);
  });

  it('completa un trabajo que termina bien', async () => {
    const { repo, calls } = fakeRepo([job({})]);
    const registry = new JobRegistry();
    registry.register({ name: 'unit.job', handle: () => Promise.resolve() });
    const worker = new JobWorker(
      registry,
      repo,
      new TenantContextService(),
      config,
    );

    expect(await worker.runOnce()).toBe(1);
    expect(calls).toEqual(['complete j1 1']);
  });

  it('un fallo se reprograma con backoff y el del último intento queda FAILED, sin el mensaje', async () => {
    const { repo, calls } = fakeRepo([
      job({ id: 'j1', attempts: 2 }),
      job({ id: 'j2', attempts: 3 }),
    ]);
    const registry = new JobRegistry();
    registry.register({
      name: 'unit.job',
      handle: () => Promise.reject(new TypeError('ana@correo.co')),
    });
    const worker = new JobWorker(
      registry,
      repo,
      new TenantContextService(),
      config,
    );

    await worker.runOnce();

    expect(calls.sort()).toEqual([
      'fail j2 3 TypeError',
      'reschedule j1 2 2000 TypeError',
    ]);
  });

  it('un trabajo que ya gastó sus intentos (arriendo vencido) no se ejecuta', async () => {
    const { repo, calls } = fakeRepo([job({ attempts: 4 })]);
    const handle = jest.fn(() => Promise.resolve());
    const registry = new JobRegistry();
    registry.register({ name: 'unit.job', handle });
    const worker = new JobWorker(
      registry,
      repo,
      new TenantContextService(),
      config,
    );

    await worker.runOnce();

    expect(handle).not.toHaveBeenCalled();
    expect(calls).toEqual(['fail j1 4 LeaseExpired']);
  });

  it('corre el handler bajo el tenant del trabajo (y sin tenant si es de plataforma)', async () => {
    const tenantContext = new TenantContextService();
    const seen: (string | undefined)[] = [];
    const { repo } = fakeRepo([
      job({ id: 'j1', tenantId: 't-1' }),
      job({ id: 'j2', tenantId: null }),
    ]);
    const registry = new JobRegistry();
    registry.register({
      name: 'unit.job',
      handle: async () => {
        await Promise.resolve();
        seen.push(tenantContext.getTenantId());
      },
    });
    const worker = new JobWorker(registry, repo, tenantContext, config);

    await worker.runOnce();

    expect(seen.sort()).toEqual(['t-1', undefined]);
  });

  it('solo reclama nombres que tiene registrados', async () => {
    const { repo } = fakeRepo([]);
    const claim = jest.spyOn(repo, 'claim');
    const registry = new JobRegistry();
    registry.register({ name: 'unit.b', handle: () => Promise.resolve() });
    registry.register({ name: 'unit.a', handle: () => Promise.resolve() });
    const worker = new JobWorker(
      registry,
      repo,
      new TenantContextService(),
      config,
    );

    await worker.runOnce();

    expect(claim).toHaveBeenCalledWith(
      ['unit.a', 'unit.b'],
      4,
      300,
      'unit:1:00000000',
    );
  });

  it('si el latido pierde el arriendo (otro worker reclamó el intento), aborta la señal y NO cierra el intento', async () => {
    const { repo, calls } = fakeRepo([job({})]);
    const heartbeat = jest.spyOn(repo, 'heartbeat').mockResolvedValue(false);
    const registry = new JobRegistry();
    registry.register({
      name: 'unit.job',
      // Trabaja hasta que le quitan el arriendo.
      handle: (_payload, ctx) =>
        new Promise<void>((resolve) =>
          ctx.signal.addEventListener('abort', () => resolve()),
        ),
    });
    const worker = new JobWorker(
      registry,
      repo,
      new TenantContextService(),
      config,
    );

    await worker.runOnce();

    expect(heartbeat).toHaveBeenCalledWith('j1', 1, 300);
    expect(calls).toEqual([]);
  });

  it('mientras el handler trabaja, renueva el arriendo con fencing por intento', async () => {
    const { repo, calls } = fakeRepo([job({ attempts: 2 })]);
    let beats = 0;
    const heartbeat = jest.spyOn(repo, 'heartbeat').mockImplementation(() => {
      beats += 1;
      return Promise.resolve(true);
    });
    const registry = new JobRegistry();
    registry.register({
      name: 'unit.job',
      handle: async () => {
        while (beats < 3) {
          await new Promise((r) => setTimeout(r, 5));
        }
      },
    });
    const worker = new JobWorker(
      registry,
      repo,
      new TenantContextService(),
      config,
    );

    await worker.runOnce();

    expect(heartbeat).toHaveBeenCalledWith('j1', 2, 300);
    expect(calls).toEqual(['complete j1 2']);
  });

  it('al pararse espera al trabajo en curso antes de resolver', async () => {
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const { repo, calls } = fakeRepo([job({})]);
    const registry = new JobRegistry();
    registry.register({
      name: 'unit.job',
      handle: () => {
        started();
        return new Promise<void>((r) => (release = r));
      },
    });
    const worker = new JobWorker(registry, repo, new TenantContextService(), {
      ...config,
      workerEnabled: true,
    });

    worker.onApplicationBootstrap();
    await running;
    const order: string[] = [];
    const stopped = worker.stop().then(() => order.push('stopped'));
    expect(worker.isStopping()).toBe(true);
    await new Promise((r) => setImmediate(r));
    order.push('release');
    release();
    await stopped;

    expect(order).toEqual(['release', 'stopped']);
    expect(calls).toEqual(['complete j1 1']);
  });
});
