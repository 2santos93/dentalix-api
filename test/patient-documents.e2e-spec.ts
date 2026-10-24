import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { PATIENT_DOCUMENT_URL_TTL } from '../src/modules/patient-documents/application/use-cases/patient-documents.use-cases';
import { createE2eApp } from './support/create-e2e-app';
import {
  dicomFixture,
  pdfFixture,
  pngFixture,
  pngRenamedAsPdf,
  svgFake,
  xlsxLikeZipFake,
} from './support/document-fixtures';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

// DX-151 · Documentos del paciente: subida con contenido comprobado, listado
// con filtros, URL firmadas para ver o descargar, anulación y auditoría.
// Todo por la API; `raw` (DIRECT_URL) solo lee filas y auditoría y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const STORAGE_ROOT = process.env.STORAGE_DIR ?? './storage-test';
/** TTL de prueba de las URL firmadas (en producción, 300 s). */
const TEST_TTL_SECONDS = 2;
const MAX_BYTES = 20 * 1024 * 1024;

interface DocumentBody {
  id: string;
  patientId: string;
  locationId: string;
  category: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  clinicalDate: string | null;
  toothNumbers: string[];
  notes: string | null;
  uploadedById: string;
  uploadedByName: string | null;
  uploadedAt: string;
  inlineViewable: boolean;
  voidedAt: string | null;
  voidedById: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

interface UrlBody {
  url: string;
  expiresAt: string;
  disposition: string;
}

const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

/** Otro PDF válido con contenido distinto (sha256 distinto). */
const pdfWith = (marker: string): Buffer =>
  Buffer.concat([pdfFixture(), Buffer.from(`% ${marker}\n`, 'latin1')]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Documentos del paciente — /patients/:patientId/documents (DX-151, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentist: { token: string; userId: string };
  let dentist2: string;
  let reception: { token: string; userId: string };
  let assistant: string;
  let patient: string;
  let patientB: string;
  let mainLocationId: string;
  let pdfDoc: DocumentBody;
  let xrayDoc: DocumentBody;
  let dicomDoc: DocumentBody;

  const call = (
    clinic: Clinic,
    token: string,
    verb: 'get' | 'post',
    url: string,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())
      [verb](`/api/v1${url}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };

  const uploadReq = (
    clinic: Clinic,
    token: string,
    patientId: string,
    bytes: Buffer,
    file: { filename: string; contentType: string },
    fields: Record<string, string> = { category: 'REPORT' },
  ) => {
    let req = request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/documents`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
    for (const [key, value] of Object.entries(fields)) {
      req = req.field(key, value);
    }
    return req.attach('file', bytes, file);
  };

  /** Sigue la URL firmada contra la misma app (disco: /files/signed). */
  const fetchSigned = (signedUrl: string) => {
    const u = new URL(signedUrl);
    return request(app.getHttpServer())
      .get(`${u.pathname}${u.search}`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
  };

  const rowCount = () =>
    raw.patientDocument.count({ where: { tenantId: a.tenantId } });

  /** Objetos guardados en el almacén de disco bajo un tenant. */
  const objectCount = async (tenantId: string): Promise<number> => {
    try {
      return (
        await fs.readdir(path.join(STORAGE_ROOT, 'patient-documents', tenantId))
      ).length;
    } catch {
      return 0;
    }
  };

  async function createPatient(
    clinic: Clinic,
    firstName: string,
    docNumber: string,
  ): Promise<string> {
    const res = await call(clinic, clinic.adminToken, 'post', '/patients', {
      firstName,
      lastName: 'Documentos',
      docType: 'CC',
      docNumber,
      sex: 'F',
    }).expect(201);
    return (res.body as { id: string }).id;
  }

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder
          .overrideProvider(PATIENT_DOCUMENT_URL_TTL)
          .useValue(TEST_TTL_SECONDS),
    });
    await resetDatabase(raw);
    a = await registerClinic(app, 'docs-a');
    b = await registerClinic(app, 'docs-b');
    const d = await seedMember(raw, a, ClinicRole.DENTIST);
    dentist = { token: await loginAs(app, a.host, d.email), userId: d.userId };
    const d2 = await raw.user.create({
      data: {
        email: 'dentist2@docs-a.test',
        passwordHash: (
          await raw.user.findUniqueOrThrow({ where: { id: d.userId } })
        ).passwordHash,
        fullName: 'Dr. Segundo',
        emailVerifiedAt: new Date(),
      },
    });
    await raw.clinicMembership.create({
      data: { tenantId: a.tenantId, userId: d2.id, role: ClinicRole.DENTIST },
    });
    dentist2 = await loginAs(app, a.host, 'dentist2@docs-a.test');
    const r = await seedMember(raw, a, ClinicRole.RECEPTION);
    reception = {
      token: await loginAs(app, a.host, r.email),
      userId: r.userId,
    };
    assistant = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.ASSISTANT)).email,
    );
    patient = await createPatient(a, 'Lucía', '53000001');
    patientB = await createPatient(b, 'Otra', '53000002');
    mainLocationId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).id;
  });

  afterAll(async () => {
    await fs.rm(path.join(STORAGE_ROOT, 'patient-documents'), {
      recursive: true,
      force: true,
    });
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('subida', () => {
    it('RECEPTION sube un PDF válido: 201, fila en la sede activa, sha256 y objeto en el disco', async () => {
      const bytes = pdfFixture();
      const res = await uploadReq(
        a,
        reception.token,
        patient,
        bytes,
        { filename: 'Remisión ortodoncia.pdf', contentType: 'application/pdf' },
        {
          category: 'REFERRAL',
          clinicalDate: '2026-01-15',
          toothNumbers: '11,21',
          notes: 'Remite Dr. Pérez',
        },
      ).expect(201);
      pdfDoc = res.body as DocumentBody;
      expect(pdfDoc).toMatchObject({
        patientId: patient,
        locationId: mainLocationId,
        category: 'REFERRAL',
        originalName: 'Remisión ortodoncia.pdf',
        mimeType: 'application/pdf',
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        clinicalDate: '2026-01-15',
        toothNumbers: ['11', '21'],
        notes: 'Remite Dr. Pérez',
        uploadedById: reception.userId,
        uploadedByName: `Miembro ${ClinicRole.RECEPTION}`,
        inlineViewable: true,
        voidedAt: null,
      });
      expect(pdfDoc).not.toHaveProperty('storageKey');

      const row = await raw.patientDocument.findUniqueOrThrow({
        where: { id: pdfDoc.id },
      });
      expect(row.storageKey).toBe(
        `patient-documents/${a.tenantId}/${pdfDoc.id}.pdf`,
      );
      expect(row.storageKey).not.toMatch(/Remisi|ortodoncia/);
      const stored = await fs.readFile(path.join(STORAGE_ROOT, row.storageKey));
      expect(stored.equals(bytes)).toBe(true);
    });

    it('con X-Location-Id la fila queda en esa sede', async () => {
      const loc = await call(a, a.adminToken, 'post', '/locations', {
        name: 'Sede Norte Docs',
      }).expect(201);
      const locationId = (loc.body as { id: string }).id;
      const res = await uploadReq(
        a,
        dentist.token,
        patient,
        pngFixture(),
        { filename: 'rx-11.png', contentType: 'image/png' },
        { category: 'XRAY', toothNumbers: '11' },
      )
        .set('X-Location-Id', locationId)
        .expect(201);
      xrayDoc = res.body as DocumentBody;
      expect(xrayDoc.locationId).toBe(locationId);
    });

    it('DICOM sin extensión: 201 y no visible en línea', async () => {
      const res = await uploadReq(
        a,
        dentist.token,
        patient,
        dicomFixture(),
        { filename: 'IM000001', contentType: 'application/octet-stream' },
        { category: 'XRAY' },
      ).expect(201);
      dicomDoc = res.body as DocumentBody;
      expect(dicomDoc).toMatchObject({
        mimeType: 'application/dicom',
        inlineViewable: false,
      });
    });

    it.each([
      [
        'PNG renombrado .pdf',
        pngRenamedAsPdf().bytes,
        { filename: 'informe.pdf', contentType: 'application/pdf' },
        'El contenido del archivo no coincide con su tipo.',
      ],
      [
        'SVG',
        svgFake(),
        { filename: 'dibujo.svg', contentType: 'image/svg+xml' },
        'Tipo de archivo no admitido. Se aceptan PDF, JPG, PNG, HEIC, DOCX y DICOM.',
      ],
      [
        'XLSX-like',
        xlsxLikeZipFake(),
        {
          filename: 'hoja.xlsx',
          contentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
        'Tipo de archivo no admitido. Se aceptan PDF, JPG, PNG, HEIC, DOCX y DICOM.',
      ],
    ])(
      '%s → 400 con el mensaje y sin fila',
      async (_l, bytes, file, message) => {
        const before = await rowCount();
        const res = await uploadReq(
          a,
          dentist.token,
          patient,
          bytes,
          file,
        ).expect(400);
        expect((res.body as { message: string }).message).toBe(message);
        expect(await rowCount()).toBe(before);
      },
    );

    it('exactamente 20 MB → 201 (multer deja pasar el límite justo)', async () => {
      const exact = Buffer.alloc(MAX_BYTES, 0x20);
      pdfFixture().copy(exact, 0);
      const res = await uploadReq(a, dentist.token, patient, exact, {
        filename: 'justo.pdf',
        contentType: 'application/pdf',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        sizeBytes: MAX_BYTES,
        mimeType: 'application/pdf',
      });
    });

    it('20 MB + 1 → 413 en español y sin fila', async () => {
      const before = await rowCount();
      const big = Buffer.concat([
        pdfFixture(),
        Buffer.alloc(MAX_BYTES + 1 - pdfFixture().length, 0x20),
      ]);
      const res = await uploadReq(a, dentist.token, patient, big, {
        filename: 'grande.pdf',
        contentType: 'application/pdf',
      });
      expect(res.status).toBe(413);
      expect(res.body).toEqual({
        statusCode: 413,
        error: 'Payload Too Large',
        message: 'El archivo supera el máximo de 20 MB.',
      });
      expect(await rowCount()).toBe(before);
    });

    it('dos archivos → 400 en español', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/patients/${patient}/documents`)
        .set('X-Tenant-Host', a.host)
        .set('Authorization', `Bearer ${dentist.token}`)
        .field('category', 'OTHER')
        .attach('file', pdfWith('uno'), 'uno.pdf')
        .attach('file', pdfWith('dos'), 'dos.pdf')
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        'Solo se admite un archivo por subida.',
      );
    });

    it('sin archivo, categoría inválida o diente no FDI → 400 en español', async () => {
      const noFile = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient}/documents`,
        { category: 'REPORT' },
      ).expect(400);
      expect((noFile.body as { message: string }).message).toBe(
        'Falta el archivo.',
      );
      const badCategory = await uploadReq(
        a,
        dentist.token,
        patient,
        pdfWith('cat'),
        { filename: 'a.pdf', contentType: 'application/pdf' },
        { category: 'SELFIE' },
      ).expect(400);
      expect((badCategory.body as { message: string }).message).toBe(
        'La categoría no es válida.',
      );
      const badTooth = await uploadReq(
        a,
        dentist.token,
        patient,
        pdfWith('tooth'),
        { filename: 'a.pdf', contentType: 'application/pdf' },
        { category: 'XRAY', toothNumbers: '11,99' },
      ).expect(400);
      expect((badTooth.body as { message: string }).message).toBe(
        'El diente «99» no es un número FDI válido.',
      );
      // El dominio rechaza un diente repetido (no lo deduplica).
      const repeated = await uploadReq(
        a,
        dentist.token,
        patient,
        pdfWith('repeated'),
        { filename: 'a.pdf', contentType: 'application/pdf' },
        { category: 'XRAY', toothNumbers: '11, 11' },
      ).expect(400);
      expect((repeated.body as { message: string }).message).toBe(
        'El diente «11» está repetido.',
      );
    });

    it('notas: 500 puntos de código pasan (aunque sean 2000 bytes); 501 → 400', async () => {
      const ok = await uploadReq(
        a,
        dentist.token,
        patient,
        pdfWith('notas-500'),
        { filename: 'notas.pdf', contentType: 'application/pdf' },
        { category: 'OTHER', notes: '🦷'.repeat(500) },
      ).expect(201);
      expect(Array.from((ok.body as DocumentBody).notes ?? '')).toHaveLength(
        500,
      );
      const before = await rowCount();
      const tooLong = await uploadReq(
        a,
        dentist.token,
        patient,
        pdfWith('notas-501'),
        { filename: 'notas.pdf', contentType: 'application/pdf' },
        { category: 'OTHER', notes: '🦷'.repeat(501) },
      ).expect(400);
      expect((tooLong.body as { message: string }).message).toBe(
        'Las notas admiten hasta 500 caracteres.',
      );
      expect(await rowCount()).toBe(before);
    });

    it('notas con un carácter NUL → 400 (no un 500 de Postgres) y sin fila ni objeto', async () => {
      const before = await rowCount();
      const objectsBefore = await objectCount(a.tenantId);
      const res = await uploadReq(
        a,
        dentist.token,
        patient,
        pdfWith('nul'),
        { filename: 'nul.pdf', contentType: 'application/pdf' },
        { category: 'OTHER', notes: 'hola\u0000mundo' },
      ).expect(400);
      expect((res.body as { message: string }).message).toBe(
        'El texto contiene caracteres no permitidos.',
      );
      expect(await rowCount()).toBe(before);
      expect(await objectCount(a.tenantId)).toBe(objectsBefore);
    });

    it('el mismo contenido vigente otra vez → 409', async () => {
      const res = await uploadReq(a, assistant, patient, pdfFixture(), {
        filename: 'copia.pdf',
        contentType: 'application/pdf',
      }).expect(409);
      expect((res.body as { message: string }).message).toBe(
        'Este archivo ya está en la ficha del paciente.',
      );
    });

    it('los cuatro roles suben y leen', async () => {
      const tokens = [a.adminToken, dentist.token, assistant, reception.token];
      for (const [i, token] of tokens.entries()) {
        await uploadReq(a, token, patient, pdfWith(`rol-${i}`), {
          filename: `rol-${i}.pdf`,
          contentType: 'application/pdf',
        }).expect(201);
        await call(a, token, 'get', `/patients/${patient}/documents`).expect(
          200,
        );
      }
    });
  });

  describe('listado y detalle', () => {
    it('más reciente primero; filtros ?category= y ?tooth=', async () => {
      const all = await call(
        a,
        dentist.token,
        'get',
        `/patients/${patient}/documents`,
      ).expect(200);
      const docs = all.body as DocumentBody[];
      const times = docs.map((d) => Date.parse(d.uploadedAt));
      expect([...times].sort((x, y) => y - x)).toEqual(times);
      expect(docs.map((d) => d.id)).toEqual(
        expect.arrayContaining([pdfDoc.id, xrayDoc.id, dicomDoc.id]),
      );

      const xrays = await call(
        a,
        dentist.token,
        'get',
        `/patients/${patient}/documents?category=XRAY`,
      ).expect(200);
      expect((xrays.body as DocumentBody[]).map((d) => d.id).sort()).toEqual(
        [xrayDoc.id, dicomDoc.id].sort(),
      );

      const tooth11 = await call(
        a,
        dentist.token,
        'get',
        `/patients/${patient}/documents?tooth=11`,
      ).expect(200);
      expect((tooth11.body as DocumentBody[]).map((d) => d.id).sort()).toEqual(
        [pdfDoc.id, xrayDoc.id].sort(),
      );

      await call(
        a,
        dentist.token,
        'get',
        `/patients/${patient}/documents?category=NOPE`,
      ).expect(400);
      const twoTeeth = await call(
        a,
        dentist.token,
        'get',
        `/patients/${patient}/documents?tooth=11&tooth=21`,
      ).expect(400);
      expect((twoTeeth.body as { message: string[] }).message).toEqual([
        'Filtra por un solo diente.',
      ]);
    });

    it('detalle de un documento', async () => {
      const res = await call(
        a,
        assistant,
        'get',
        `/patients/${patient}/documents/${pdfDoc.id}`,
      ).expect(200);
      expect(res.body).toMatchObject({ id: pdfDoc.id, sha256: pdfDoc.sha256 });
    });
  });

  describe('URL firmadas', () => {
    it('inline de un PDF: 200, la URL responde con el PDF y Content-Disposition inline', async () => {
      const res = await call(
        a,
        reception.token,
        'get',
        `/patients/${patient}/documents/${pdfDoc.id}/url/inline`,
      ).expect(200);
      const body = res.body as UrlBody;
      expect(body.disposition).toBe('inline');
      expect(res.headers['cache-control']).toBe('no-store');
      const file = await fetchSigned(body.url).expect(200);
      expect(file.headers['content-type']).toContain('application/pdf');
      expect(file.headers['content-disposition']).toMatch(
        /^inline; filename="Remisio?n ortodoncia\.pdf"; filename\*=UTF-8''Remisi%C3%B3n%20ortodoncia\.pdf$/,
      );
      expect((file.body as Buffer).equals(pdfFixture())).toBe(true);
    });

    it('descarga: Content-Disposition attachment', async () => {
      const res = await call(
        a,
        dentist.token,
        'get',
        `/patients/${patient}/documents/${dicomDoc.id}/url/download`,
      ).expect(200);
      const body = res.body as UrlBody;
      expect(body.disposition).toBe('attachment');
      const file = await fetchSigned(body.url).expect(200);
      expect(file.headers['content-disposition']).toMatch(/^attachment;/);
      expect(file.headers['content-type']).toContain('application/dicom');
    });

    it('DICOM en línea → 400 «solo se puede descargar»', async () => {
      const res = await call(
        a,
        dentist.token,
        'get',
        `/patients/${patient}/documents/${dicomDoc.id}/url/inline`,
      ).expect(400);
      expect((res.body as { message: string }).message).toBe(
        'Este tipo solo se puede descargar.',
      );
    });

    it('la URL caduca: pasado el TTL el almacén responde 403', async () => {
      const res = await call(
        a,
        dentist.token,
        'get',
        `/patients/${patient}/documents/${pdfDoc.id}/url/download`,
      ).expect(200);
      const body = res.body as UrlBody;
      expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(
        TEST_TTL_SECONDS * 1000,
      );
      await sleep((TEST_TTL_SECONDS + 1.2) * 1000);
      await fetchSigned(body.url).expect(403);
    });
  });

  describe('anulación', () => {
    it('sin motivo 400; otro odontólogo 403; el autor anula (200); dos veces 409', async () => {
      const own = (
        await uploadReq(a, dentist.token, patient, pdfWith('anular'), {
          filename: 'anular.pdf',
          contentType: 'application/pdf',
        }).expect(201)
      ).body as DocumentBody;
      const voidUrl = `/patients/${patient}/documents/${own.id}/void`;
      await call(a, dentist.token, 'post', voidUrl, {}).expect(400);
      // Dos puntos de código (cuatro unidades UTF-16): 400, no un 500 del CHECK.
      const nul = await call(a, dentist.token, 'post', voidUrl, {
        reason: 'abc\u0000def',
      }).expect(400);
      expect((nul.body as { message: string }).message).toBe(
        'El texto contiene caracteres no permitidos.',
      );
      expect(
        (await raw.patientDocument.findUniqueOrThrow({ where: { id: own.id } }))
          .voidedAt,
      ).toBeNull();
      const emoji = await call(a, dentist.token, 'post', voidUrl, {
        reason: '🦷🦷',
      }).expect(400);
      expect((emoji.body as { message: string }).message).toBe(
        'El motivo debe tener entre 3 y 500 caracteres.',
      );
      const forbidden = await call(a, dentist2, 'post', voidUrl, {
        reason: 'No es mío',
      }).expect(403);
      expect((forbidden.body as { message: string }).message).toBe(
        'Solo quien subió el documento o un administrador puede anularlo.',
      );
      const voided = await call(a, dentist.token, 'post', voidUrl, {
        reason: 'Paciente equivocado',
      }).expect(200);
      expect(voided.body).toMatchObject({
        voidedById: dentist.userId,
        voidedByName: `Miembro ${ClinicRole.DENTIST}`,
        voidReason: 'Paciente equivocado',
      });
      expect((voided.body as DocumentBody).voidedAt).not.toBeNull();
      const again = await call(a, a.adminToken, 'post', voidUrl, {
        reason: 'Otra vez',
      }).expect(409);
      expect((again.body as { message: string }).message).toBe(
        'El documento ya está anulado.',
      );

      // Sigue en la ficha y se puede descargar.
      const list = await call(
        a,
        reception.token,
        'get',
        `/patients/${patient}/documents`,
      ).expect(200);
      expect(
        (list.body as DocumentBody[]).find((d) => d.id === own.id)?.voidedAt,
      ).not.toBeNull();
      await call(
        a,
        reception.token,
        'get',
        `/patients/${patient}/documents/${own.id}/url/download`,
      ).expect(200);
    });

    it('ADMIN anula el documento de otro', async () => {
      await call(
        a,
        a.adminToken,
        'post',
        `/patients/${patient}/documents/${xrayDoc.id}/void`,
        { reason: 'Radiografía repetida' },
      ).expect(200);
    });

    it('no hay ruta para editar ni borrar un documento', async () => {
      for (const verb of ['patch', 'put', 'delete'] as const) {
        await request(app.getHttpServer())
          [verb](`/api/v1/patients/${patient}/documents/${pdfDoc.id}`)
          .set('X-Tenant-Host', a.host)
          .set('Authorization', `Bearer ${a.adminToken}`)
          .send({ category: 'OTHER' })
          .expect(404);
      }
      const row = await raw.patientDocument.findUniqueOrThrow({
        where: { id: pdfDoc.id },
      });
      expect(row.category).toBe('REFERRAL');
    });
  });

  describe('OpenAPI', () => {
    it('la categoría del multipart es el enum con nombre PatientDocumentCategory', () => {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      );
      const body = doc.paths['/api/v1/patients/{patientId}/documents'].post
        ?.requestBody as {
        content: Record<
          string,
          { schema: { properties: Record<string, { $ref?: string }> } }
        >;
      };
      expect(
        body.content['multipart/form-data'].schema.properties.category,
      ).toEqual({ $ref: '#/components/schemas/PatientDocumentCategory' });
      expect(doc.components?.schemas?.PatientDocumentCategory).toMatchObject({
        type: 'string',
        enum: [
          'XRAY',
          'PHOTO',
          'REFERRAL',
          'SIGNED_CONSENT',
          'REPORT',
          'OTHER',
        ],
      });
    });
  });

  describe('auditoría', () => {
    it('CREATE, VIEW (lista, detalle, inline), EXPORT y VOID con paciente y sin el nombre del fichero', async () => {
      const events = await raw.auditEvent.findMany({
        where: { tenantId: a.tenantId, resourceType: 'PATIENT_DOCUMENT' },
        orderBy: { occurredAt: 'asc' },
      });
      const of = (action: string, reason?: string) =>
        events.filter(
          (e) =>
            e.action === action &&
            (reason === undefined ||
              (e.metadata as { reason?: string }).reason === reason),
        );
      expect(
        of('CREATE').find((e) => e.resourceId === pdfDoc.id),
      ).toMatchObject({
        patientId: patient,
        actorUserId: reception.userId,
      });
      expect(of('VIEW', 'DOCUMENT_LIST').length).toBeGreaterThan(0);
      expect(
        of('VIEW').find(
          (e) =>
            e.resourceId === pdfDoc.id &&
            (e.metadata as { reason?: string }).reason === undefined,
        ),
      ).toBeDefined();
      expect(
        of('VIEW', 'DOCUMENT_VIEW').find((e) => e.resourceId === pdfDoc.id),
      ).toMatchObject({ patientId: patient });
      expect(
        of('EXPORT', 'DOCUMENT_DOWNLOAD').find(
          (e) => e.resourceId === dicomDoc.id,
        ),
      ).toMatchObject({ patientId: patient });
      expect(of('VOID').find((e) => e.resourceId === xrayDoc.id)).toMatchObject(
        { patientId: patient, actorUserId: a.adminUserId },
      );
      // Ni el nombre del fichero ni el del usuario en la metadata.
      for (const e of events) {
        const meta = JSON.stringify(e.metadata);
        expect(meta).not.toMatch(
          /Remisi|ortodoncia|\.pdf|Miembro|originalName/,
        );
        expect(e.patientId).toBe(patient);
      }
      // Lo fallido no deja evento (409, 403, 400).
      expect(of('VOID')).toHaveLength(2);
    });
  });

  describe('aislamiento entre clínicas', () => {
    it('B → 404 en lista, detalle, URL, subida y anulación, sin cambios en A', async () => {
      const before = await raw.patientDocument.findMany({
        where: { tenantId: a.tenantId },
        orderBy: { id: 'asc' },
      });
      const base = `/patients/${patient}/documents`;
      await call(b, b.adminToken, 'get', base).expect(404);
      await call(b, b.adminToken, 'get', `${base}/${pdfDoc.id}`).expect(404);
      await call(
        b,
        b.adminToken,
        'get',
        `${base}/${pdfDoc.id}/url/inline`,
      ).expect(404);
      await call(
        b,
        b.adminToken,
        'get',
        `${base}/${pdfDoc.id}/url/download`,
      ).expect(404);
      await call(b, b.adminToken, 'post', `${base}/${pdfDoc.id}/void`, {
        reason: 'Intento ajeno',
      }).expect(404);
      const objectsOfA = await objectCount(a.tenantId);
      await uploadReq(b, b.adminToken, patient, pdfWith('ajeno'), {
        filename: 'ajeno.pdf',
        contentType: 'application/pdf',
      }).expect(404);
      // Nada llegó al almacén: ni bajo B ni bajo A.
      expect(await objectCount(b.tenantId)).toBe(0);
      expect(await objectCount(a.tenantId)).toBe(objectsOfA);
      // El documento de A tampoco es alcanzable por la ruta del paciente de B.
      await call(
        b,
        b.adminToken,
        'get',
        `/patients/${patientB}/documents/${pdfDoc.id}`,
      ).expect(404);
      expect(
        await raw.patientDocument.findMany({
          where: { tenantId: a.tenantId },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(before);
      expect(
        await raw.patientDocument.count({ where: { tenantId: b.tenantId } }),
      ).toBe(0);
    });
  });
});
