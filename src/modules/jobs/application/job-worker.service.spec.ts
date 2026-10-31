import { Logger } from '@nestjs/common';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { ClaimedJob } from '../domain/job';
import type {
  JobRepository,
  ScheduleToFire,
} from '../domain/job-repository.port';
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
  healthPort: null,
  version: null,
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
    fireDueSchedules: jest.fn(() => Promise.resolve({ fired: 0, skipped: [] })),
    listFailed: jest.fn(),
    purgeFinished: jest.fn(),
    failExhausted: jest.fn(() => Promise.resolve([])),
    beat: jest.fn(() => Promise.resolve()),
    purgeStaleWorkers: jest.fn(),
    statementTimeoutMs: jest.fn(() => Promise.resolve(0)),
    snapshot: jest.fn(),
    retryFailed: jest.fn(),
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

  it('DX-422: un trabajo agotado al reclamarlo avisa a su onExhausted (bajo su tenant) sin ejecutar el handler', async () => {
    const { repo, calls } = fakeRepo([
      job({ attempts: 4, tenantId: 't-1', payload: { consentId: 'c1' } }),
    ]);
    const tenantContext = new TenantContextService();
    const handle = jest.fn(() => Promise.resolve());
    const seen: unknown[] = [];
    const registry = new JobRegistry();
    registry.register({
      name: 'unit.job',
      handle,
      onExhausted: (payload, ctx) => {
        seen.push([payload, ctx.tenantId, tenantContext.getTenantId()]);
        return Promise.resolve();
      },
    });
    const worker = new JobWorker(registry, repo, tenantContext, config);
    await worker.runOnce();
    expect(handle).not.toHaveBeenCalled();
    expect(calls).toEqual(['fail j1 4 LeaseExpired']);
    expect(seen).toEqual([[{ consentId: 'c1' }, 't-1', 't-1']]);
  });

  it('DX-422: los RUNNING agotados que cierra failExhausted también avisan a onExhausted; si el aviso falla, la vuelta sigue', async () => {
    const { repo } = fakeRepo([]);
    (repo.failExhausted as jest.Mock).mockResolvedValue([
      {
        id: 'x1',
        name: 'unit.job',
        tenantId: 't-1',
        attempts: 5,
        payload: { consentId: 'c1' },
      },
      {
        id: 'x2',
        name: 'unit.job',
        tenantId: 't-2',
        attempts: 5,
        payload: { consentId: 'c2' },
      },
    ]);
    const tenantContext = new TenantContextService();
    const seen: unknown[] = [];
    const registry = new JobRegistry();
    registry.register({
      name: 'unit.job',
      handle: () => Promise.resolve(),
      onExhausted: (payload) => {
        seen.push([payload, tenantContext.getTenantId()]);
        return payload.consentId === 'c1'
          ? Promise.reject(new Error('db'))
          : Promise.resolve();
      },
    });
    const worker = new JobWorker(registry, repo, tenantContext, config);
    await expect(worker.runOnce()).resolves.toBeDefined();
    expect(seen).toEqual([
      [{ consentId: 'c1' }, 't-1'],
      [{ consentId: 'c2' }, 't-2'],
    ]);
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

  describe('DX-220: fila envenenada, latido y liveness', () => {
    afterEach(() => jest.useRealTimers());

    it('cada vuelta cierra los RUNNING agotados (failExhausted) ANTES de reclamar', async () => {
      const { repo } = fakeRepo([]);
      const worker = new JobWorker(
        new JobRegistry(),
        repo,
        new TenantContextService(),
        config,
      );
      await worker.runOnce();
      const exhausted = (repo.failExhausted as jest.Mock).mock
        .invocationCallOrder[0];
      const claim = (repo.claim as jest.Mock).mock.invocationCallOrder[0];
      expect(exhausted).toBeLessThan(claim);
    });

    it('el bucle late en job_workers con su id, papel y versión (runOnce no: lo usan los tests con role api)', async () => {
      jest.useFakeTimers();
      const { repo } = fakeRepo([]);
      const beat = jest.fn(() => Promise.resolve());
      repo.beat = beat;
      const worker = new JobWorker(
        new JobRegistry(),
        repo,
        new TenantContextService(),
        { ...config, role: 'all', version: 'a1b2c3d' },
      );
      await worker.runOnce();
      expect(beat).not.toHaveBeenCalled();

      worker.start();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(config.pollIntervalMs);
      await worker.stop();
      expect(beat).toHaveBeenCalledWith({
        id: config.workerId,
        role: 'all',
        version: 'a1b2c3d',
      });
      expect(beat.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('un latido que falla no impide reclamar en esa vuelta', async () => {
      jest.useFakeTimers();
      const { repo, calls } = fakeRepo([job({})]);
      (repo.beat as jest.Mock).mockRejectedValue(new Error('db down'));
      const registry = new JobRegistry();
      registry.register({ name: 'unit.job', handle: () => Promise.resolve() });
      const worker = new JobWorker(
        registry,
        repo,
        new TenantContextService(),
        config,
      );
      worker.start();
      await jest.advanceTimersByTimeAsync(0);
      await worker.stop();
      expect(calls).toEqual(['complete j1 1']);
    });

    it('la liveness falla en ≤ 3 vueltas si el bucle se bloquea (repositorio que no responde)', async () => {
      jest.useFakeTimers();
      const { repo } = fakeRepo([]);
      let hang = false;
      // A partir de la 3.ª vuelta el reclamo no vuelve nunca.
      (repo.claim as jest.Mock).mockImplementation(() =>
        hang ? new Promise(() => {}) : Promise.resolve([]),
      );
      const worker = new JobWorker(
        new JobRegistry(),
        repo,
        new TenantContextService(),
        config,
      );
      worker.start();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(config.pollIntervalMs);
      expect(worker.liveness.report()).toMatchObject({
        alive: true,
        staleAfterMs: 3 * config.pollIntervalMs,
      });

      hang = true;
      await jest.advanceTimersByTimeAsync(config.pollIntervalMs);
      // Bloqueado: nadie apunta más vueltas. Sigue vivo hasta 3 periodos…
      await jest.advanceTimersByTimeAsync(2 * config.pollIntervalMs);
      expect(worker.liveness.report().alive).toBe(true);
      // …y a la 3.ª vuelta perdida la sonda ya falla.
      await jest.advanceTimersByTimeAsync(config.pollIntervalMs + 1);
      expect(worker.liveness.report()).toMatchObject({
        alive: false,
        stopping: false,
      });

      // El apagado no se queda colgado esperando a la vuelta bloqueada.
      const stopped = worker.stop();
      await jest.advanceTimersByTimeAsync(config.shutdownGraceMs);
      await stopped;
      // Durante el apagado la sonda no lo da por muerto.
      expect(worker.liveness.report()).toMatchObject({
        alive: true,
        stopping: true,
      });
    });

    it('el umbral suma el statement_timeout de la conexión', async () => {
      const { repo } = fakeRepo([]);
      (repo.statementTimeoutMs as jest.Mock).mockResolvedValue(30_000);
      const worker = new JobWorker(
        new JobRegistry(),
        repo,
        new TenantContextService(),
        config,
      );
      worker.start();
      await new Promise((r) => setImmediate(r));
      await worker.stop();
      expect(worker.liveness.staleAfterMs).toBe(
        3 * config.pollIntervalMs + 30_000,
      );
    });
  });

  // DX-380 (OPS-046): el worker pasa `singleton` de cada tarea al repositorio
  // y deja en el log cada tick saltado, con el nombre de la tarea y nada más.
  it('dispara las tareas con su `singleton` y avisa de cada tick saltado (jobs.schedule_skipped)', async () => {
    const fire = jest.fn((schedules: ScheduleToFire[]) =>
      Promise.resolve({
        fired: schedules.length - 1,
        skipped: ['unit.sweep.every-minute'],
      }),
    );
    const repo: JobRepository = {
      ...fakeRepo([]).repo,
      fireDueSchedules: fire,
    };
    const registry = new JobRegistry();
    registry.register({ name: 'unit.sweep', handle: () => Promise.resolve() });
    registry.schedule({
      name: 'unit.sweep.every-minute',
      cron: '* * * * *',
      job: 'unit.sweep',
      singleton: true,
    });
    registry.schedule({
      name: 'unit.sweep.daily',
      cron: '7 3 * * *',
      job: 'unit.sweep',
    });
    const log = jest.spyOn(Logger.prototype, 'log');
    const worker = new JobWorker(
      registry,
      repo,
      new TenantContextService(),
      config,
    );

    await worker.runOnce();

    const [schedules] = fire.mock.calls[0];
    expect(schedules.map((s) => [s.name, s.singleton])).toEqual([
      ['unit.sweep.every-minute', true],
      ['unit.sweep.daily', false],
    ]);
    expect(log).toHaveBeenCalledWith({
      event: 'jobs.schedule_skipped',
      schedule: 'unit.sweep.every-minute',
    });
    expect(log).toHaveBeenCalledWith({
      event: 'jobs.schedules_fired',
      count: 1,
    });
    log.mockRestore();
  });
});
