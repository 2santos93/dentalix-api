import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { DiskFileStorage } from '../src/shared/storage/disk-file-storage';
import { FILE_STORAGE } from '../src/shared/storage/file-storage.port';
import {
  UPLOAD_BUSY_MESSAGE,
  UPLOAD_SLOTS,
  UploadSlots,
} from '../src/shared/storage/upload-slots';
import { createE2eApp } from './support/create-e2e-app';
import { pdfFixture, pngFixture } from './support/document-fixtures';
import { Clinic, registerClinic, resetDatabase } from './support/e2e-fixtures';
import { tempFilesCreatedDuring } from './support/temp-dir-watch';

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const STORAGE_ROOT = process.env.STORAGE_DIR ?? './storage-test';

interface Ticket {
  documentId: string;
  url: string;
  fields: Record<string, string>;
}

const hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// DX-259 con STORAGE_DRIVER=disk (desarrollo y tests): `upload-url` devuelve
// el mismo formulario que el POST prefirmado de S3, pero hacia la propia API
// (`/files/uploads`, multer a un temporal en disco y semáforo de subidas);
// `complete` es el mismo. Además, el semáforo: sin plaza, 503 con
// Retry-After en las rutas que reciben ficheros.
describe('Documentos: subida directa con el almacén en disco (DX-259, e2e)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let patientId: string;
  let slots: UploadSlots;

  const api = (verb: 'get' | 'post', url: string) =>
    request(app.getHttpServer())
      [verb](`/api/v1${url}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);

  const ask = (bytes: Buffer) =>
    api('post', `/patients/${patientId}/documents/upload-url`)
      .send({
        fileName: 'informe.pdf',
        mimeType: 'application/pdf',
        sizeBytes: bytes.length,
        sha256: hex(bytes),
      })
      .expect(200)
      .then((res) => res.body as Ticket);

  /** El formulario del navegador, contra la ruta de la API del ticket. */
  const post = (
    ticket: Ticket,
    bytes: Buffer,
    override: Record<string, string> = {},
  ) => {
    let req = request(app.getHttpServer()).post(new URL(ticket.url).pathname);
    for (const [name, value] of Object.entries({
      ...ticket.fields,
      ...override,
    })) {
      req = req.field(name, value);
    }
    return req.attach('file', bytes, { filename: 'blob' });
  };

  beforeAll(async () => {
    app = await createE2eApp();
    expect(app.get(FILE_STORAGE)).toBeInstanceOf(DiskFileStorage);
    slots = app.get<UploadSlots>(UPLOAD_SLOTS);
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'docs-disco');
    const res = await api('post', '/patients')
      .send({
        firstName: 'Ana',
        lastName: 'Disco',
        docType: 'CC',
        docNumber: '59200001',
        sex: 'F',
      })
      .expect(201);
    patientId = (res.body as { id: string }).id;
  });

  afterAll(async () => {
    await fs.rm(path.join(STORAGE_ROOT, 'patient-documents'), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(STORAGE_ROOT, '.meta'), {
      recursive: true,
      force: true,
    });
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('upload-url → POST a /files/uploads (204) → complete (201): el mismo flujo que con S3', async () => {
    const bytes = pdfFixture();
    const ticket = await ask(bytes);
    expect(ticket.url).toBe(`${process.env.FILES_PUBLIC_BASE_URL}/uploads`);
    await post(ticket, bytes).expect(204);
    const done = await api(
      'post',
      `/patients/${patientId}/documents/${ticket.documentId}/complete`,
    )
      .send({
        category: 'REPORT',
        fileName: 'informe.pdf',
        toothNumbers: ['11'],
      })
      .expect(201);
    expect(done.body).toMatchObject({
      id: ticket.documentId,
      sha256: hex(bytes),
      toothNumbers: ['11'],
    });
    expect(slots.active).toBe(0);

    // Repetir `complete` devuelve el mismo documento y no audita otro CREATE.
    const again = await api(
      'post',
      `/patients/${patientId}/documents/${ticket.documentId}/complete`,
    )
      .send({ category: 'REPORT' })
      .expect(201);
    expect((again.body as { id: string }).id).toBe(ticket.documentId);
    expect(
      await raw.auditEvent.count({
        where: {
          tenantId: clinic.tenantId,
          action: 'CREATE',
          resourceType: 'PATIENT_DOCUMENT',
          resourceId: ticket.documentId,
        },
      }),
    ).toBe(1);
  });

  it('formulario manipulado → 403; contenido con otra huella → 400 en español; sin objeto', async () => {
    const bytes = Buffer.concat([pdfFixture(), Buffer.from('% d\n')]);
    const ticket = await ask(bytes);
    const tampered = await post(ticket, bytes, {
      key: `patient-documents/pending/${clinic.tenantId}/otro`,
    }).expect(403);
    expect((tampered.body as { message: string }).message).toBe(
      'La autorización de subida no es válida o caducó. Vuelve a intentarlo.',
    );
    const wrong = await post(ticket, pngFixture()).expect(400);
    expect((wrong.body as { message: string }).message).toBe(
      'El archivo no coincide con su huella SHA-256. Vuelve a subirlo.',
    );
    await api(
      'post',
      `/patients/${patientId}/documents/${ticket.documentId}/complete`,
    )
      .send({ category: 'REPORT' })
      .expect(404);
  });

  it('semáforo lleno → 503 con Retry-After en la subida directa, la multipart y el avatar, sin leer el cuerpo', async () => {
    const held: (() => void)[] = [];
    for (let r = slots.tryAcquire(); r; r = slots.tryAcquire()) held.push(r);
    try {
      const bytes = Buffer.concat([pdfFixture(), Buffer.from('% e\n')]);
      const ticket = await ask(bytes);
      for (const res of [
        await post(ticket, bytes),
        await api('post', `/patients/${patientId}/documents`)
          .field('category', 'REPORT')
          .attach('file', bytes, {
            filename: 'a.pdf',
            contentType: 'application/pdf',
          }),
        await api('post', '/me/avatar').attach('file', pngFixture(), {
          filename: 'a.png',
          contentType: 'image/png',
        }),
      ]) {
        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('5');
        expect((res.body as { message: string }).message).toBe(
          UPLOAD_BUSY_MESSAGE,
        );
      }
    } finally {
      held.forEach((release) => release());
    }
    expect(slots.active).toBe(0);
  });

  it('otra clínica: upload-url y complete del paciente o del documento de A → 404, sin tocar nada', async () => {
    const bytes = Buffer.concat([pdfFixture(), Buffer.from('% f\n')]);
    const ticket = await ask(bytes);
    await post(ticket, bytes).expect(204);
    const other = await registerClinic(app, 'docs-disco-b');
    const asB = (url: string) =>
      request(app.getHttpServer())
        .post(`/api/v1${url}`)
        .set('X-Tenant-Host', other.host)
        .set('Authorization', `Bearer ${other.adminToken}`);
    await asB(`/patients/${patientId}/documents/upload-url`)
      .send({ sizeBytes: bytes.length, sha256: hex(bytes) })
      .expect(404);
    await asB(`/patients/${patientId}/documents/${ticket.documentId}/complete`)
      .send({ category: 'REPORT' })
      .expect(404);
    const patientB = (
      await asB('/patients')
        .send({
          firstName: 'Otra',
          lastName: 'Clínica',
          docType: 'CC',
          docNumber: '59200002',
          sex: 'F',
        })
        .expect(201)
    ).body as { id: string };
    // Con un paciente propio, el id de A no existe en su prefijo: 404.
    await asB(
      `/patients/${patientB.id}/documents/${ticket.documentId}/complete`,
    )
      .send({ category: 'REPORT' })
      .expect(404);
    // El de A sigue pendiente y A lo completa.
    await api(
      'post',
      `/patients/${patientId}/documents/${ticket.documentId}/complete`,
    )
      .send({ category: 'REPORT' })
      .expect(201);
  });

  it('firma inválida → 403 SIN escribir el fichero en disco; un error de multer sale en español', async () => {
    const bytes = Buffer.concat([pdfFixture(), Buffer.alloc(512 * 1024, 0x20)]);
    const ticket = await ask(bytes);
    let status = 0;
    const created = await tempFilesCreatedDuring(async () => {
      status = (await post(ticket, bytes, { signature: 'ab'.repeat(32) }))
        .status;
    });
    expect(status).toBe(403);
    expect(created).toEqual([]);
    expect(slots.active).toBe(0);

    // Dos ficheros: el error de multer, en español.
    let req = request(app.getHttpServer()).post('/api/v1/files/uploads');
    for (const [name, value] of Object.entries(ticket.fields)) {
      req = req.field(name, value);
    }
    const res = await req
      .attach('file', bytes, { filename: 'a' })
      .attach('file', bytes, { filename: 'b' })
      .expect(400);
    expect((res.body as { message: string }).message).toBe(
      'Solo se admite un archivo por subida.',
    );
  });
});
