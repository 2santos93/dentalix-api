import { INestApplicationContext, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { JobRegistry } from '../src/modules/jobs/application/job-registry';
import { JobQueue } from '../src/modules/jobs/application/job-queue.service';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import { JOBS_CONFIG } from '../src/modules/jobs/infrastructure/jobs-config';
import type { JobsConfig } from '../src/modules/jobs/infrastructure/jobs-config';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { deferred, waitFor } from './support/wait-for';

// DX-085: apagado ordenado del worker con la app REAL (AppModule, como el
// proceso APP_ROLE=worker): `close()` (lo que dispara SIGTERM con
// enableShutdownHooks) no resuelve hasta que el trabajo en curso termina, y
// ese trabajo aún puede usar la BD (el worker se destruye antes que Prisma).
const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const NAME = 'test-shutdown.slow';

describe('DX-085 · apagado ordenado del worker (int)', () => {
  let app: INestApplicationContext;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  afterAll(async () => {
    await owner.$executeRaw`DELETE FROM "jobs" WHERE "name" = ${NAME}`;
    await owner.$disconnect();
    Logger.overrideLogger(true);
  });

  it('termina el trabajo en curso (y lo marca COMPLETED) antes de cerrar', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JOBS_CONFIG)
      .useFactory({
        factory: (): JobsConfig => ({
          role: 'worker',
          workerEnabled: true,
          workerId: 'int:shutdown:00000000',
          pollIntervalMs: 50,
          concurrency: 2,
          leaseSeconds: 300,
          maxAttempts: 3,
          retryBaseMs: 1000,
          shutdownGraceMs: 30_000,
          retentionDays: 14,
        }),
      })
      .compile();
    app = moduleRef;

    const started = deferred();
    const release = deferred();
    const events: string[] = [];
    app.get(JobRegistry).register({
      name: NAME,
      handle: async () => {
        started.resolve();
        await release.promise;
        // Después de la señal de apagado el handler sigue pudiendo usar la BD.
        await app.get(PrismaService).$queryRaw`SELECT 1`;
        events.push('job-done');
      },
    });
    await app.init(); // arranca el worker (onApplicationBootstrap)
    const { id } = await app.get(JobQueue).enqueue(NAME, {});
    await started.promise;

    const closing = app.close().then(() => events.push('closed'));
    const worker = app.get(JobWorker);
    await waitFor(() => worker.isStopping(), 'el worker recibe el apagado');
    expect(events).toEqual([]);

    release.resolve();
    await closing;

    expect(events).toEqual(['job-done', 'closed']);
    expect(await owner.job.findUniqueOrThrow({ where: { id } })).toMatchObject({
      state: 'COMPLETED',
      attempts: 1,
    });
  });
});
