import { Logger } from '@nestjs/common';
import { request } from 'node:http';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { JobRegistry } from '../application/job-registry';
import { JobWorker } from '../application/job-worker.service';
import type { JobRepository } from '../domain/job-repository.port';
import type { JobsConfig } from './jobs-config';
import { JobsHealthServer } from './jobs-health-server';

const POLL_MS = 20;

const config: JobsConfig = {
  role: 'worker',
  workerEnabled: true,
  workerId: 'unit:health:00000000',
  pollIntervalMs: POLL_MS,
  concurrency: 2,
  leaseSeconds: 300,
  maxAttempts: 5,
  retryBaseMs: 1000,
  shutdownGraceMs: 50,
  heartbeatMs: 100_000,
  retentionDays: 14,
  healthPort: 0,
  version: null,
};

/** Repositorio que deja de responder cuando `hang()` (la BD no contesta). */
function hangingRepo() {
  let hung = false;
  const answer = <T>(value: T) =>
    hung ? new Promise<T>(() => {}) : Promise.resolve(value);
  const repo = {
    beat: () => answer(undefined),
    statementTimeoutMs: () => answer(0),
    syncSchedules: () => answer(undefined),
    fireDueSchedules: () => answer(0),
    failExhausted: () => answer([]),
    claim: () => answer([]),
  } as unknown as JobRepository;
  return { repo, hang: () => (hung = true) };
}

function get(
  port: number,
  path: string,
  method = 'GET',
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(data) as Record<string, unknown>,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function until(
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<number> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
  return Date.now() - started;
}

describe('JobsHealthServer (sonda de liveness del worker, DX-220)', () => {
  let worker: JobWorker;
  let server: JobsHealthServer;
  let port: number;
  let hang: () => void;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });
  afterAll(() => {
    Logger.overrideLogger(true);
  });

  beforeEach(async () => {
    const fake = hangingRepo();
    hang = fake.hang;
    worker = new JobWorker(
      new JobRegistry(),
      fake.repo,
      new TenantContextService(),
      config,
    );
    server = new JobsHealthServer(worker, config);
    worker.start();
    port = await server.listen(0);
  });

  afterEach(async () => {
    await worker.stop();
    await server.close();
  });

  it('200 mientras el bucle da vueltas', async () => {
    await until(
      () => Promise.resolve(worker.liveness.report().lastLoopAt !== null),
      500,
    );
    const res = await get(port, '/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      staleAfterMs: 3 * POLL_MS,
    });
    // Sin nada de la cola: solo estado y tiempos.
    expect(Object.keys(res.body).sort()).toEqual(
      ['ageMs', 'lastLoopAt', 'staleAfterMs', 'status'].sort(),
    );
  });

  it('503 en ≤ 3 vueltas si el bucle se bloquea (el repositorio no responde)', async () => {
    await until(async () => (await get(port, '/health')).status === 200, 500);
    hang();
    const blockedAt = Date.now();
    await until(async () => (await get(port, '/health')).status === 503, 2000);
    const elapsed = Date.now() - blockedAt;
    // Una vuelta en curso + 3 periodos, con margen para el bucle de eventos.
    expect(elapsed).toBeLessThanOrEqual(4 * POLL_MS + 200);
    expect((await get(port, '/health')).body).toMatchObject({
      status: 'stale',
    });
  });

  it('solo GET /health: lo demás es 404 (sin rutas de negocio)', async () => {
    expect((await get(port, '/api/v1/patients')).status).toBe(404);
    expect((await get(port, '/health/ready')).status).toBe(404);
    expect((await get(port, '/health', 'POST')).status).toBe(404);
    expect((await get(port, '/health?x=1')).status).toBe(200);
  });

  it('sin JOBS_HEALTH_PORT (o sin worker) no abre nada', async () => {
    const quiet = new JobsHealthServer(worker, { ...config, healthPort: null });
    await quiet.onApplicationBootstrap();
    const api = new JobsHealthServer(worker, {
      ...config,
      role: 'api',
      workerEnabled: false,
    });
    await api.onApplicationBootstrap();
    expect(quiet.port()).toBeNull();
    expect(api.port()).toBeNull();
    expect(server.port()).toBe(port);
  });
});
