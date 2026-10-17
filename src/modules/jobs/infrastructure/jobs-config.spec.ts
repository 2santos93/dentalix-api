import { loadJobsConfig } from './jobs-config';

const from =
  (env: Record<string, string>) =>
  (key: string): string | undefined =>
    env[key];

describe('loadJobsConfig', () => {
  it('por defecto el proceso es la API y no ejecuta trabajos', () => {
    const config = loadJobsConfig(from({}));
    expect(config).toMatchObject({
      role: 'api',
      workerEnabled: false,
      pollIntervalMs: 2000,
      concurrency: 4,
      leaseSeconds: 300,
      maxAttempts: 5,
      retryBaseMs: 30_000,
      shutdownGraceMs: 20_000,
      heartbeatMs: 100_000,
      retentionDays: 14,
      healthPort: null,
      version: null,
    });
    expect(config.workerId).toMatch(/^[\w.-]+:\d+:[0-9a-f]{8}$/);
  });

  it('APP_ROLE=worker y APP_ROLE=all (desarrollo, un solo proceso) ejecutan trabajos', () => {
    expect(loadJobsConfig(from({ APP_ROLE: 'worker' }))).toMatchObject({
      role: 'worker',
      workerEnabled: true,
    });
    expect(loadJobsConfig(from({ APP_ROLE: ' ALL ' }))).toMatchObject({
      role: 'all',
      workerEnabled: true,
    });
  });

  it('con NODE_ENV=test el worker NUNCA arranca aunque .env traiga APP_ROLE (salvo JOBS_WORKER_IN_TESTS=1)', () => {
    expect(
      loadJobsConfig(from({ NODE_ENV: 'test', APP_ROLE: 'all' })),
    ).toMatchObject({ role: 'all', workerEnabled: false });
    expect(
      loadJobsConfig(
        from({
          NODE_ENV: 'test',
          APP_ROLE: 'worker',
          JOBS_WORKER_IN_TESTS: '1',
        }),
      ),
    ).toMatchObject({ workerEnabled: true });
  });

  it('el latido renueva el arriendo a un tercio de su duración', () => {
    expect(loadJobsConfig(from({ JOBS_LEASE_SECONDS: '60' })).heartbeatMs).toBe(
      20_000,
    );
  });

  it('lee los ajustes numéricos y cae al default con un valor raro (la validación del arranque ya lo rechaza)', () => {
    const config = loadJobsConfig(
      from({
        JOBS_POLL_INTERVAL_MS: '500',
        JOBS_CONCURRENCY: '8',
        JOBS_LEASE_SECONDS: '60',
        JOBS_MAX_ATTEMPTS: '3',
        JOBS_RETRY_BASE_MS: '1000',
        JOBS_SHUTDOWN_GRACE_MS: '0',
        JOBS_RETENTION_DAYS: 'x',
      }),
    );
    expect(config).toMatchObject({
      pollIntervalMs: 500,
      concurrency: 8,
      leaseSeconds: 60,
      maxAttempts: 3,
      retryBaseMs: 1000,
      shutdownGraceMs: 0,
      retentionDays: 14,
    });
  });

  it('DX-220: JOBS_HEALTH_PORT abre la sonda del worker y APP_VERSION va al latido; sin ellos, null', () => {
    expect(
      loadJobsConfig(
        from({ JOBS_HEALTH_PORT: '9464', APP_VERSION: 'a1b2c3d' }),
      ),
    ).toMatchObject({ healthPort: 9464, version: 'a1b2c3d' });
    expect(
      loadJobsConfig(from({ JOBS_HEALTH_PORT: ' ', APP_VERSION: '' })),
    ).toMatchObject({ healthPort: null, version: null });
    // Valores raros (ya los rechaza validateEnv): sin sonda y sin versión.
    expect(
      loadJobsConfig(
        from({ JOBS_HEALTH_PORT: '70000', APP_VERSION: 'v 1; DROP' }),
      ),
    ).toMatchObject({ healthPort: null, version: null });
  });
});
