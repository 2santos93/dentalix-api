import { INestApplication, Logger } from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { waitFor } from './support/wait-for';
import { JOB_REPOSITORY } from '../src/modules/jobs/domain/job-repository.port';
import type { JobRepository } from '../src/modules/jobs/domain/job-repository.port';
import { JOBS_CONFIG } from '../src/modules/jobs/infrastructure/jobs-config';
import type { JobsConfig } from '../src/modules/jobs/infrastructure/jobs-config';
import { JobsHealthServer } from '../src/modules/jobs/infrastructure/jobs-health-server';

// DX-220 (OPS-029): con APP_ROLE=all y la cola BLOQUEADA (un repositorio que
// no responde), la sonda del worker (JOBS_HEALTH_PORT) pasa a 503 y las
// sondas de la API (GET /health y /health/ready, que hace SELECT 1 en la BD
// real) siguen en 200: la readiness de la API no depende del worker.

/** Cada método de la cola se queda colgado (la BD de la cola no contesta). */
const never = () => new Promise<never>(() => {});
const hungRepository: JobRepository = {
  insert: never,
  transactionTenant: never,
  heartbeat: never,
  claim: never,
  failExhausted: never,
  complete: never,
  reschedule: never,
  fail: never,
  syncSchedules: never,
  fireDueSchedules: never,
  listFailed: never,
  purgeFinished: never,
  beat: never,
  purgeStaleWorkers: never,
  statementTimeoutMs: never,
  snapshot: never,
  retryFailed: never,
};

function probe(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/health' },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Sonda del worker frente a la readiness de la API (e2e, DX-220)', () => {
  let app: INestApplication<App>;
  let port: number;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    app = await createE2eApp({
      override: (builder) =>
        builder
          .overrideProvider(JOB_REPOSITORY)
          .useValue(hungRepository)
          .overrideProvider(JOBS_CONFIG)
          .useFactory({
            factory: (): JobsConfig => ({
              role: 'all',
              workerEnabled: true,
              workerId: 'e2e:health:00000000',
              pollIntervalMs: 50,
              concurrency: 1,
              leaseSeconds: 300,
              maxAttempts: 3,
              retryBaseMs: 1000,
              shutdownGraceMs: 100,
              heartbeatMs: 100_000,
              retentionDays: 14,
              healthPort: 0,
              version: null,
            }),
          }),
    });
    port = app.get(JobsHealthServer).port() as number;
  });

  afterAll(async () => {
    await app.close();
    Logger.overrideLogger(true);
  });

  it('el bucle bloqueado tumba la sonda del worker, no las de la API', async () => {
    expect(port).toBeGreaterThan(0);
    await waitFor(
      async () => (await probe(port)) === 503,
      'la sonda del worker da 503 con el bucle bloqueado',
      { timeoutMs: 2000 },
    );

    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200)
      .expect({ status: 'ok', database: 'up' });
  });
});
