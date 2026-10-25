import './storage/s3-avatar-env';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { FILE_STORAGE } from '../src/shared/storage/file-storage.port';
import { S3FileStorage } from '../src/shared/storage/s3-file-storage';
import { createE2eApp } from './support/create-e2e-app';
import { pdfFixture, pngFixture, svgFake } from './support/document-fixtures';
import { Clinic, registerClinic, resetDatabase } from './support/e2e-fixtures';
import { describeWithMinio, ensureBucket } from './support/minio';
import { tempFilesCreatedDuring } from './support/temp-dir-watch';
import {
  UPLOAD_SLOTS,
  type UploadSlots,
} from '../src/shared/storage/upload-slots';

const run = promisify(execFile);
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const MB = 1024 * 1024;

interface Ticket {
  documentId: string;
  method: 'POST';
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
  maxBytes: number;
}

const hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const b64 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('base64');

/** RSS del proceso en bytes (la API corre en este proceso de jest). */
const rss = () => process.memoryUsage().rss;

// DX-259 (OPS-038): la subida directa al bucket con STORAGE_DRIVER=s3
// (MinIO). El fichero lo sube `curl` (OTRO proceso, como el navegador) a la
// URL del POST prefirmado: no pasa por la API, que solo autoriza y después
// comprueba con HeadObject + Range. Se mide el RSS de este proceso (el de la
// API) durante la subida y el `complete`.
describeWithMinio(
  'Documentos: subida directa al bucket (DX-259, e2e)',
  (cfg) => {
    let app: INestApplication<App>;
    let clinic: Clinic;
    let patientId: string;
    let s3: S3Client;
    let dir: string;

    const api = (verb: 'get' | 'post', url: string, body?: object) => {
      const req = request(app.getHttpServer())
        [verb](`/api/v1${url}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`);
      return body ? req.send(body) : req;
    };

    const ask = (
      bytes: Buffer,
      name = 'informe.pdf',
      mimeType = 'application/pdf',
    ) =>
      api('post', `/patients/${patientId}/documents/upload-url`, {
        fileName: name,
        mimeType,
        sizeBytes: bytes.length,
        sha256: hex(bytes),
      });

    /** Lo que hace el navegador: los campos en orden y el fichero al final. */
    async function curlUpload(ticket: Ticket, file: string): Promise<string> {
      const args = [
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '-X',
        'POST',
      ];
      for (const [name, value] of Object.entries(ticket.fields)) {
        args.push('-F', `${name}=${value}`);
      }
      args.push('-F', `file=@${file}`, ticket.url);
      const { stdout } = await run('curl', args);
      return stdout.trim();
    }

    const pendingKey = (documentId: string) =>
      `patient-documents/pending/${clinic.tenantId}/${documentId}`;

    const finish = (documentId: string, body: object = {}) =>
      api('post', `/patients/${patientId}/documents/${documentId}/complete`, {
        category: 'XRAY',
        fileName: 'informe.pdf',
        mimeType: 'application/pdf',
        ...body,
      });

    beforeAll(async () => {
      s3 = await ensureBucket(cfg);
      dir = mkdtempSync(path.join(tmpdir(), 'dx259-e2e-'));
      app = await createE2eApp();
      expect(app.get(FILE_STORAGE)).toBeInstanceOf(S3FileStorage);
      await resetDatabase(raw);
      clinic = await registerClinic(app, 'docs-directo');
      const res = await api('post', '/patients', {
        firstName: 'Ana',
        lastName: 'Directo',
        docType: 'CC',
        docNumber: '59000001',
        sex: 'F',
      }).expect(201);
      patientId = (res.body as { id: string }).id;
    });

    afterAll(async () => {
      rmSync(dir, { recursive: true, force: true });
      await resetDatabase(raw);
      await app.close();
      await raw.$disconnect();
    });

    it('19 MB: autoriza, el fichero va directo al bucket, complete lo comprueba y crea la fila; el RSS de la API sube < 5 MB', async () => {
      const file = path.join(dir, 'escaneo-19mb.pdf');
      const sha = (() => {
        const bytes = Buffer.concat([
          pdfFixture(),
          Buffer.alloc(19 * MB - pdfFixture().length, 0x20),
        ]);
        writeFileSync(file, bytes);
        return { hex: hex(bytes), size: bytes.length };
      })();

      const ticket = (
        await api('post', `/patients/${patientId}/documents/upload-url`, {
          fileName: 'escaneo-19mb.pdf',
          mimeType: 'application/pdf',
          sizeBytes: sha.size,
          sha256: sha.hex,
        }).expect(200)
      ).body as Ticket;
      expect(new URL(ticket.url).origin).toBe(new URL(cfg.endpoint!).origin);
      expect(ticket.fields.key).toBe(pendingKey(ticket.documentId));

      // Línea base con la app ya caliente; se muestrea durante la subida.
      global.gc?.();
      const baseline = rss();
      let peak = baseline;
      const sampler = setInterval(() => {
        peak = Math.max(peak, rss());
      }, 5);
      try {
        expect(await curlUpload(ticket, file)).toBe('204');
        const done = await finish(ticket.documentId, {
          fileName: 'escaneo-19mb.pdf',
        }).expect(201);
        expect(done.body).toMatchObject({
          id: ticket.documentId,
          sizeBytes: sha.size,
          sha256: sha.hex,
          mimeType: 'application/pdf',
          originalName: 'escaneo-19mb.pdf',
        });
      } finally {
        clearInterval(sampler);
      }
      peak = Math.max(peak, rss());
      const grewMb = (peak - baseline) / MB;
      console.info(
        `[DX-259] RSS de la API durante la subida de 19 MB: +${grewMb.toFixed(2)} MB`,
      );
      expect(grewMb).toBeLessThan(5);

      // La fila apunta a la clave definitiva; el pendiente se borra tras
      // crearla, sin que la respuesta lo espere (revisión M-2).
      const row = await raw.patientDocument.findUniqueOrThrow({
        where: { id: ticket.documentId },
      });
      expect(row.storageKey).toBe(
        `patient-documents/${clinic.tenantId}/${ticket.documentId}-${sha.hex.slice(0, 16)}.pdf`,
      );
      const storage = app.get<S3FileStorage>(FILE_STORAGE);
      const deadline = Date.now() + 5000;
      while (await storage.stat(pendingKey(ticket.documentId))) {
        if (Date.now() > deadline) throw new Error('el pendiente sigue ahí');
        await new Promise((r) => setTimeout(r, 50));
      }

      // Se ve: la URL en línea sirve el PDF entero desde el bucket.
      const inline = await api(
        'get',
        `/patients/${patientId}/documents/${ticket.documentId}/url/inline`,
      ).expect(200);
      const served = await fetch((inline.body as { url: string }).url);
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toBe('application/pdf');
      expect(Number(served.headers.get('content-length'))).toBe(sha.size);
      await served.body?.cancel();

      // Auditado al completar, como la subida multipart (CREATE con paciente).
      const audit = await raw.auditEvent.findFirst({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'PATIENT_DOCUMENT',
          action: 'CREATE',
          resourceId: ticket.documentId,
        },
      });
      expect(audit?.patientId).toBe(patientId);
    }, 60_000);

    it('contenido fuera de la lista blanca: 400 en español, sin fila y el objeto se borra del bucket', async () => {
      const bytes = svgFake();
      const ticket = (
        await ask(bytes, 'dibujo.svg', 'image/svg+xml').expect(200)
      ).body as Ticket;
      const file = path.join(dir, 'dibujo.svg');
      writeFileSync(file, bytes);
      expect(await curlUpload(ticket, file)).toBe('204');
      const res = await finish(ticket.documentId, {
        fileName: 'dibujo.svg',
        mimeType: 'image/svg+xml',
      }).expect(400);
      expect((res.body as { message: string }).message).toBe(
        'Tipo de archivo no admitido. Se aceptan PDF, JPG, PNG, HEIC, DOCX y DICOM.',
      );
      // QA D3: definitivo, la web no ofrece «Reintentar».
      expect((res.body as { code?: string }).code).toBe(
        'DOCUMENT_CONTENT_REJECTED',
      );
      expect(
        await raw.patientDocument.count({ where: { id: ticket.documentId } }),
      ).toBe(0);
      expect(
        await app
          .get<S3FileStorage>(FILE_STORAGE)
          .stat(pendingKey(ticket.documentId)),
      ).toBeNull();
    });

    it('un objeto sin el checksum (subido saltándose el POST prefirmado): 400, sin fila y borrado', async () => {
      const bytes = pngFixture();
      const ticket = (await ask(bytes, 'foto.png', 'image/png').expect(200))
        .body as Ticket;
      await s3.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: pendingKey(ticket.documentId),
          Body: bytes,
          Metadata: {
            'uploaded-by': clinic.adminUserId,
            'patient-id': patientId,
            'declared-size': String(bytes.length),
            sha256: hex(bytes),
          },
        }),
      );
      const res = await finish(ticket.documentId, {
        fileName: 'foto.png',
        mimeType: 'image/png',
      }).expect(400);
      expect((res.body as { message: string }).message).toBe(
        'El archivo subido no coincide con su huella SHA-256. Vuelve a subirlo.',
      );
      expect(
        await raw.patientDocument.count({ where: { id: ticket.documentId } }),
      ).toBe(0);
      expect(
        await app
          .get<S3FileStorage>(FILE_STORAGE)
          .stat(pendingKey(ticket.documentId)),
      ).toBeNull();
    });

    it('un tamaño distinto del declarado: 400, sin fila y borrado', async () => {
      const declared = Buffer.concat([pdfFixture(), Buffer.from('% a\n')]);
      const actual = Buffer.concat([declared, Buffer.from('% más\n')]);
      const ticket = (await ask(declared).expect(200)).body as Ticket;
      await s3.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: pendingKey(ticket.documentId),
          Body: actual,
          ChecksumSHA256: b64(actual),
          Metadata: {
            'uploaded-by': clinic.adminUserId,
            'patient-id': patientId,
            'declared-size': String(declared.length),
            sha256: hex(actual),
          },
        }),
      );
      const res = await finish(ticket.documentId).expect(400);
      expect((res.body as { message: string }).message).toBe(
        'El tamaño del archivo subido no coincide con el declarado. Vuelve a subirlo.',
      );
      expect(
        await app
          .get<S3FileStorage>(FILE_STORAGE)
          .stat(pendingKey(ticket.documentId)),
      ).toBeNull();
    });

    it('el almacén rechaza un contenido distinto del de la huella declarada (no llega al bucket); complete → 404', async () => {
      const declared = Buffer.concat([pdfFixture(), Buffer.from('% b\n')]);
      const ticket = (await ask(declared).expect(200)).body as Ticket;
      const file = path.join(dir, 'otro.pdf');
      writeFileSync(file, Buffer.concat([pdfFixture(), Buffer.from('% c\n')]));
      expect(await curlUpload(ticket, file)).toBe('400');
      const res = await finish(ticket.documentId).expect(404);
      expect((res.body as { message: string }).message).toBe(
        'No encontramos el archivo subido o la subida caducó. Vuelve a subirlo.',
      );
    });

    it('más de 20 MB: 413 al pedir la autorización', async () => {
      const res = await api(
        'post',
        `/patients/${patientId}/documents/upload-url`,
        {
          fileName: 'enorme.pdf',
          sizeBytes: 20 * MB + 1,
          sha256: 'a'.repeat(64),
        },
      ).expect(413);
      expect((res.body as { message: string }).message).toBe(
        'El archivo supera el máximo de 20 MB.',
      );
    });

    it('con S3, POST /files/uploads anónimo → 404 sin ocupar plaza del semáforo ni escribir en disco', async () => {
      const slots = app.get<UploadSlots>(UPLOAD_SLOTS);
      let status = 0;
      const created = await tempFilesCreatedDuring(async () => {
        const res = await request(app.getHttpServer())
          .post('/api/v1/files/uploads')
          .field('key', 'patient-documents/pending/x/y')
          .attach('file', Buffer.alloc(2 * MB, 1), { filename: 'x' });
        status = res.status;
      });
      expect(status).toBe(404);
      expect(created).toEqual([]);
      expect(slots.active).toBe(0);
    });
  },
);
