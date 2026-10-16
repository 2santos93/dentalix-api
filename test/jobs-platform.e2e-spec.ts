import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { PrismaClient } from '@prisma/client';
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

// DX-085: cola de fallidos en GET /platform/jobs/failed. Solo superadmin con
// token de plataforma (403 a cualquier rol de clínica, 401 sin sesión) y
// documentado en Swagger. El fallo se produce de verdad: un handler que
// siempre lanza agota sus intentos en el worker.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

describe('GET /platform/jobs/failed (e2e, DX-085)', () => {
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
});
