import {
  HUNG_STORAGE_PORT,
  UNAVAILABLE_REQUEST_TIMEOUT_MS,
} from './s3-unavailable-env';
import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { STORAGE_UNAVAILABLE_MESSAGE } from '../../src/shared/storage/storage-errors';
import { createE2eApp } from '../support/create-e2e-app';
import { pdfFixture } from '../support/document-fixtures';
import { Clinic, registerClinic, resetDatabase } from '../support/e2e-fixtures';
import {
  startHungTcpServer,
  waitUntil,
  type HungTcpServer,
} from '../support/hung-tcp-server';

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
/** Margen sobre S3_REQUEST_TIMEOUT_MS para el resto de la petición. */
const MARGIN_MS = 1500;

// DX-259 (OPS-039): con el almacén sin responder (acepta la conexión y
// calla, como un MinIO en pausa), una lectura (avatar) y una subida (el
// `complete` de un documento) fallan en ≤ S3_REQUEST_TIMEOUT_MS + margen con
// un 503 en español y Retry-After, y no quedan sockets colgados. El resto de
// la API sigue respondiendo.
describe('Almacén sin responder (DX-259, e2e)', () => {
  let hung: HungTcpServer;
  let app: INestApplication<App>;
  let clinic: Clinic;

  beforeAll(async () => {
    hung = await startHungTcpServer(HUNG_STORAGE_PORT);
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'almacen-colgado');
    // El HeadBucket del arranque (solo aviso) también vence y cierra.
    await waitUntil(() => hung.openSockets() === 0, 5000);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await hung.close();
    await raw.$disconnect();
  });

  async function timed(fn: () => Promise<request.Response>) {
    const started = Date.now();
    const res = await fn();
    return { res, elapsed: Date.now() - started };
  }

  function expectUnavailable(res: request.Response, elapsed: number) {
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect((res.body as { message: string }).message).toBe(
      STORAGE_UNAVAILABLE_MESSAGE,
    );
    expect(elapsed).toBeLessThanOrEqual(
      UNAVAILABLE_REQUEST_TIMEOUT_MS + MARGIN_MS,
    );
  }

  it('lectura: GET de un avatar → 503 en español a tiempo y sin sockets colgados', async () => {
    const { res, elapsed } = await timed(() =>
      request(app.getHttpServer()).get(
        '/api/v1/files/avatars/00000000-0000-4000-8000-000000000000-0123456789abcdef.png',
      ),
    );
    expectUnavailable(res, elapsed);
    // Revisión I-2: el 503 de un avatar versionado no se cachea (nunca immutable).
    expect(res.headers['cache-control']).toBe('no-store');
    await waitUntil(() => hung.openSockets() === 0, 1000);
  });

  it('subida: complete de un documento → 503 en español a tiempo, sin fila y sin sockets colgados; la API sigue viva', async () => {
    const auth = (req: request.Test) =>
      req
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`);
    const patient = await auth(
      request(app.getHttpServer()).post('/api/v1/patients'),
    )
      .send({
        firstName: 'Ana',
        lastName: 'Colgado',
        docType: 'CC',
        docNumber: '59100001',
        sex: 'F',
      })
      .expect(201);
    const patientId = (patient.body as { id: string }).id;
    const bytes = pdfFixture();
    // Firmar la autorización no sale a la red: funciona aunque S3 no responda.
    const ticket = await auth(
      request(app.getHttpServer()).post(
        `/api/v1/patients/${patientId}/documents/upload-url`,
      ),
    )
      .send({
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
      .expect(200);
    const documentId = (ticket.body as { documentId: string }).documentId;

    const { res, elapsed } = await timed(() =>
      auth(
        request(app.getHttpServer()).post(
          `/api/v1/patients/${patientId}/documents/${documentId}/complete`,
        ),
      ).send({ category: 'REPORT', fileName: 'informe.pdf' }),
    );
    expectUnavailable(res, elapsed);
    expect(await raw.patientDocument.count({ where: { id: documentId } })).toBe(
      0,
    );
    await waitUntil(() => hung.openSockets() === 0, 1000);

    // Lo que no toca el almacén sigue respondiendo.
    await auth(
      request(app.getHttpServer()).get(`/api/v1/patients/${patientId}`),
    ).expect(200);
  });
});
