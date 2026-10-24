import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  platformAdminToken,
  registerClinic,
  resetDatabase,
} from './support/e2e-fixtures';
import { JobRegistry } from '../src/modules/jobs/application/job-registry';
import { JobQueue } from '../src/modules/jobs/application/job-queue.service';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';

// DX-085: cola de fallidos en GET /platform/jobs/failed. DX-220: estado de la
// cola en GET /platform/jobs/stats y reencolado en POST
// /platform/jobs/:id/retry. Solo superadmin con token de plataforma (403 a
// cualquier rol de clínica, 401 sin sesión; los cuatro roles los recorre
// role-matrix.e2e-spec.ts) y documentado en Swagger. El fallo se produce de
// verdad: un handler que siempre lanza agota sus intentos en el worker.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

describe('/platform/jobs (e2e, DX-085, DX-220)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let platformToken: string;
  let failedId: string;

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'clinica-cola');
    platformToken = await platformAdminToken(app, raw);

    app.get(JobRegistry).register({
      name: 'test-e2e.always-fails',
      maxAttempts: 1,
      handle: () =>
        Promise.reject(new Error('paciente ana@correo.co sin teléfono')),
    });
    const queue = app.get(JobQueue);
    ({ id: failedId } = await queue.enqueue(
      'test-e2e.always-fails',
      { appointmentId: '00000000-0000-4000-8000-000000000001' },
      { tenantId: clinic.tenantId },
    ));
    await app.get(JobWorker).drain();
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('el superadmin ve el trabajo fallido, sin el mensaje del error', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/platform/jobs/failed')
      .set('X-Tenant-Host', 'localhost')
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);

    const body = res.body as Record<string, unknown>[];
    expect(body).toEqual([
      {
        id: failedId,
        name: 'test-e2e.always-fails',
        tenantId: clinic.tenantId,
        payload: { appointmentId: '00000000-0000-4000-8000-000000000001' },
        attempts: 1,
        maxAttempts: 1,
        lastError: 'Error',
        createdAt: expect.any(String) as string,
        finishedAt: expect.any(String) as string,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('ana@correo.co');
  });

  it('acota con limit (1..100) y rechaza un limit inválido', async () => {
    const get = (query: string) =>
      request(app.getHttpServer())
        .get(`/api/v1/platform/jobs/failed${query}`)
        .set('X-Tenant-Host', 'localhost')
        .set('Authorization', `Bearer ${platformToken}`);
    await get('?limit=1').expect(200);
    await get('?limit=0').expect(400);
    await get('?limit=101').expect(400);
  });

  it('403 al ADMIN de una clínica y 401 sin sesión', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/platform/jobs/failed')
      .set('X-Tenant-Host', 'localhost')
      .set('Authorization', `Bearer ${clinic.adminToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/platform/jobs/failed')
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/platform/jobs/failed')
      .set('X-Tenant-Host', 'localhost')
      .expect(401);
  });

  it('está documentado en Swagger (respuesta tipada y seguridad bearer)', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    const operation = document.paths['/api/v1/platform/jobs/failed']?.get;
    expect(operation).toBeDefined();
    expect(operation?.tags).toEqual(['platform']);
    expect(operation?.security).toEqual([{ bearer: [] }]);
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '401', '403']),
    );
    expect(document.components?.schemas?.FailedJobDto).toBeDefined();
  });

  const asPlatform = (verb: 'get' | 'post', path: string) =>
    request(app.getHttpServer())
      [verb](`/api/v1/platform/jobs${path}`)
      .set('X-Tenant-Host', 'localhost')
      .set('Authorization', `Bearer ${platformToken}`);

  interface Stats {
    generatedAt: string;
    queue: {
      pendingDue: number;
      pendingScheduled: number;
      lagMs: number;
      oldestDueRunAt: string | null;
      running: number;
      runningExpired: number;
      failedLast24h: number;
    };
    workers: {
      alive: number;
      lastBeatAt: string | null;
      recent: { id: string; alive: boolean }[];
    };
    schedules: {
      name: string;
      cron: string;
      lastRunAt: string | null;
      nextRunAt: string | null;
      periodMs: number;
      delayMs: number;
      overdue: boolean;
    }[];
  }
  const stats = async (): Promise<Stats> =>
    (await asPlatform('get', '/stats').expect(200)).body as Stats;
  const reminders = (s: Stats) =>
    s.schedules.find((t) => t.name === 'reminders.plan.every-5-min');
  const ago = (ms: number) => new Date(Date.now() - ms);

  describe('GET /platform/jobs/stats (DX-220)', () => {
    it('sin latido de ningún worker: 0 vivos; una tarea que nadie sincronizó aparece con retraso', async () => {
      // El drain del beforeAll ya sincronizó las tareas (runOnce no late).
      const body = await stats();
      expect(body.workers).toEqual({ alive: 0, lastBeatAt: null, recent: [] });
      expect(body.queue.failedLast24h).toBe(1);
      expect(body.schedules.length).toBeGreaterThanOrEqual(7);
      expect(body.schedules.every((t) => !t.overdue)).toBe(true);
      expect(reminders(body)).toMatchObject({
        cron: '*/5 * * * *',
        periodMs: 300_000,
        overdue: false,
      });

      // Una réplica nueva registró una tarea que ningún worker ha sincronizado.
      const purge = await raw.jobSchedule.delete({
        where: { name: 'jobs.purge-finished.daily' },
      });
      try {
        expect(
          (await stats()).schedules.find(
            (t) => t.name === 'jobs.purge-finished.daily',
          ),
        ).toMatchObject({
          nextRunAt: null,
          lastRunAt: null,
          overdue: true,
          periodMs: 86_400_000,
        });
      } finally {
        await raw.jobSchedule.create({ data: purge });
      }
    });

    it('con el worker parado: 0 vivos, retraso creciente y reminders.plan.every-5-min con retraso tras 2 periodos', async () => {
      // Un worker sincronizó las tareas y luego se paró hace 2 min.
      await raw.jobWorker.create({
        data: {
          id: 'worker-e2e:1:00000000',
          role: 'worker',
          version: 'e2e',
          lastBeatAt: ago(120_000),
        },
      });
      expect(reminders(await stats())).toMatchObject({ overdue: false });

      // Un recordatorio que nadie recoge desde hace 10 min.
      const { id } = await app
        .get(JobQueue)
        .enqueue(
          'test-e2e.always-fails',
          { appointmentId: '00000000-0000-4000-8000-000000000002' },
          { tenantId: clinic.tenantId },
        );
      await raw.job.update({ where: { id }, data: { runAt: ago(600_000) } });

      // Menos de 2 periodos (9 min de retraso con cron de 5 min): aún no.
      await raw.jobSchedule.update({
        where: { name: 'reminders.plan.every-5-min' },
        data: { nextRunAt: ago(9 * 60_000) },
      });
      const first = await stats();
      expect(first.workers.alive).toBe(0);
      expect(first.workers.recent).toEqual([
        expect.objectContaining({ id: 'worker-e2e:1:00000000', alive: false }),
      ]);
      expect(first.queue.pendingDue).toBe(1);
      expect(first.queue.lagMs).toBeGreaterThanOrEqual(600_000 - 2000);
      expect(reminders(first)).toMatchObject({ overdue: false });

      // Más de 2 periodos (11 min): con retraso.
      await raw.jobSchedule.update({
        where: { name: 'reminders.plan.every-5-min' },
        data: { nextRunAt: ago(11 * 60_000) },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await stats();
      expect(second.queue.lagMs).toBeGreaterThan(first.queue.lagMs);
      expect(reminders(second)).toMatchObject({ overdue: true });
      expect(reminders(second)?.delayMs).toBeGreaterThan(2 * 300_000);

      // Vuelve un worker: late y cuenta como vivo.
      await raw.jobWorker.update({
        where: { id: 'worker-e2e:1:00000000' },
        data: { lastBeatAt: new Date() },
      });
      expect((await stats()).workers.alive).toBe(1);

      await raw.job.delete({ where: { id } });
    });

    it('nunca devuelve payloads ni datos de pacientes', async () => {
      const res = await asPlatform('get', '/stats').expect(200);
      expect(res.text).not.toContain('payload');
      expect(res.text).not.toContain('appointmentId');
      expect(res.text).not.toContain('ana@correo.co');
    });

    it('403 al ADMIN de una clínica (en su host y en el apex) y 401 sin sesión', async () => {
      for (const host of ['localhost', clinic.host]) {
        await request(app.getHttpServer())
          .get('/api/v1/platform/jobs/stats')
          .set('X-Tenant-Host', host)
          .set('Authorization', `Bearer ${clinic.adminToken}`)
          .expect(403);
      }
      await request(app.getHttpServer())
        .get('/api/v1/platform/jobs/stats')
        .set('X-Tenant-Host', 'localhost')
        .expect(401);
    });
  });

  describe('POST /platform/jobs/:id/retry (DX-220)', () => {
    it('403 al ADMIN de una clínica y 401 sin sesión, sin tocar el trabajo', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/platform/jobs/${failedId}/retry`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .expect(403);
      await request(app.getHttpServer())
        .post(`/api/v1/platform/jobs/${failedId}/retry`)
        .set('X-Tenant-Host', 'localhost')
        .expect(401);
      expect(
        await raw.job.findUniqueOrThrow({ where: { id: failedId } }),
      ).toMatchObject({ state: 'FAILED' });
    });

    it('reencola el FAILED una sola vez (attempts 0), sin el payload, auditado; el segundo da 409', async () => {
      const res = await asPlatform('post', `/${failedId}/retry`)
        .set('User-Agent', 'e2e-ops')
        .expect(200);
      expect(res.body).toEqual({
        id: failedId,
        name: 'test-e2e.always-fails',
        tenantId: clinic.tenantId,
        state: 'PENDING',
        attempts: 0,
        previousAttempts: 1,
      });
      expect(res.text).not.toContain('appointmentId');
      expect(
        await raw.job.findUniqueOrThrow({ where: { id: failedId } }),
      ).toMatchObject({ state: 'PENDING', attempts: 0, finishedAt: null });

      await asPlatform('post', `/${failedId}/retry`).expect(409);

      const audit = await raw.platformAuditEvent.findMany({
        where: { resourceId: failedId },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'JOB_RETRIED',
        resourceType: 'JOB',
        userAgent: 'e2e-ops',
        metadata: {
          jobName: 'test-e2e.always-fails',
          tenantId: clinic.tenantId,
          previousAttempts: 1,
          lastError: 'Error',
        },
      });
      expect(audit[0].requestId).toEqual(expect.any(String));
      expect(JSON.stringify(audit)).not.toContain('appointmentId');
      const superadmin = await raw.user.findUniqueOrThrow({
        where: { email: 'root@platform.test' },
      });
      expect(audit[0].actorUserId).toBe(superadmin.id);

      // El worker lo vuelve a ejecutar (y, como siempre falla, vuelve a FAILED).
      await app.get(JobWorker).drain();
      expect(
        await raw.job.findUniqueOrThrow({ where: { id: failedId } }),
      ).toMatchObject({ state: 'FAILED', attempts: 1 });
    });

    it('404 si no existe y 400 si el id no es un UUID', async () => {
      await asPlatform(
        'post',
        '/00000000-0000-4000-8000-00000000dead/retry',
      ).expect(404);
      await asPlatform('post', '/no-es-uuid/retry').expect(400);
    });
  });

  it('DX-220: stats y retry documentados en Swagger', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    const statsOp = document.paths['/api/v1/platform/jobs/stats']?.get;
    const retryOp = document.paths['/api/v1/platform/jobs/{id}/retry']?.post;
    for (const op of [statsOp, retryOp]) {
      expect(op?.tags).toEqual(['platform']);
      expect(op?.security).toEqual([{ bearer: [] }]);
    }
    expect(Object.keys(statsOp?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '401', '403']),
    );
    expect(Object.keys(retryOp?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '404', '409']),
    );
    expect(document.components?.schemas?.JobsStatsDto).toBeDefined();
    expect(document.components?.schemas?.RetriedJobDto).toBeDefined();
  });
});
