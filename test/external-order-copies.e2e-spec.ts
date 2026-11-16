import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { pdfTextLines } from '../src/modules/consents/infrastructure/pdf/__fixtures__/pdf-text';
import { hashPublicLinkToken } from '../src/shared/public-links/public-link-token';
import { EXTERNAL_ORDER_COPY_USED_CODE } from '../src/modules/external-orders/domain/external-order-copy-link';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

// DX-572 en HTTP real: «Enviar al paciente» la copia de una orden externa
// (email por el outbox o WhatsApp) y la página pública. Enlace de UN SOLO USO
// de 7 días (solo su hash en la BD): abrir la página no lo gasta, descargar
// sí (410 con su código la segunda vez). Reenviar o anular la orden lo
// invalidan, archivar al paciente (DX-461) también, otra clínica 404 y la
// apertura y la descarga quedan auditadas sin usuario. La copia del paciente
// lleva la nota clínica.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const NOTE = 'Dolor a la percusión en el 36';

interface Sent {
  channel: 'EMAIL' | 'WHATSAPP';
  sentAt: string;
  expiresAt: string;
  destinationMasked: string;
  recipientKind: 'PATIENT' | 'RESPONSIBLE';
  whatsapp: { phone: string; text: string; url: string } | null;
}

interface PublicCopy {
  status: 'AVAILABLE' | 'USED';
  clinic: { name: string } | null;
  numberLabel: string;
  kind: string;
  issuedAt: string;
  format: { timeZone: string };
}

const tokenOf = (url: string) => url.split('/').pop()!;

const binary = (r: request.Response, cb: (e: null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  r.on('data', (c: Buffer) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('Copia de la orden externa para el paciente (e2e, DX-572)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let patientId: string;
  let dentistToken: string;
  let receptionToken: string;

  const server = () => request(app.getHttpServer());
  const as = (clinic: Clinic, token = clinic.adminToken) => {
    const set = (req: request.Test) =>
      req
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
    return {
      get: (path: string) => set(server().get(`/api/v1${path}`)),
      post: (path: string, payload: object = {}) =>
        set(server().post(`/api/v1${path}`)).send(payload),
    };
  };
  const open = (host: string, token: string) =>
    server()
      .get(`/api/v1/public/external-order-copies/${encodeURIComponent(token)}`)
      .set('X-Tenant-Host', host);
  const download = (host: string, token: string) =>
    server()
      .post(
        `/api/v1/public/external-order-copies/${encodeURIComponent(token)}/download`,
      )
      .set('X-Tenant-Host', host)
      .buffer(true)
      .parse(binary);

  const newPatient = async (
    firstName: string,
    over: object = {},
  ): Promise<string> => {
    const res = await as(clinicA)
      .post('/patients', {
        docType: 'NATIONAL_ID',
        docNumber: `${Math.floor(10_000_000 + Math.random() * 9_000_000)}`,
        sex: 'F',
        firstName,
        lastName: 'Rondón',
        birthDate: '1985-06-20',
        phone: '+58 412 1234567',
        email: `${firstName.toLowerCase()}@example.com`,
        ...over,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  const order = async (patient = patientId): Promise<string> =>
    (
      (
        await as(clinicA, dentistToken)
          .post(`/patients/${patient}/external-orders`, {
            kind: 'SPECIALIST',
            recipient: 'Dr. Especialista en ATM',
            items: ['Valoración de articulación temporomandibular'],
            clinicalNote: NOTE,
          })
          .expect(201)
      ).body as { id: string }
    ).id;

  const send = (
    orderId: string,
    channel: 'EMAIL' | 'WHATSAPP' = 'WHATSAPP',
    clinic = clinicA,
    token = clinic === clinicA ? receptionToken : clinic.adminToken,
  ) =>
    as(clinic, token).post(`/external-orders/${orderId}/patient-copy`, {
      channel,
    });

  const whatsAppToken = async (orderId: string): Promise<string> =>
    tokenOf(((await send(orderId).expect(200)).body as Sent).whatsapp!.url);

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    clinicA = await registerClinic(app, 'dx572-copia-a');
    clinicB = await registerClinic(app, 'dx572-copia-b');
    patientId = await newPatient('Mariela');
    const dentist = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    await raw.clinicMembership.updateMany({
      where: { tenantId: clinicA.tenantId, userId: dentist.userId },
      data: { professionalLicense: 'REG-45678' },
    });
    dentistToken = await loginAs(app, clinicA.host, dentist.email);
    const reception = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    receptionToken = await loginAs(app, clinicA.host, reception.email);
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('por WhatsApp (recepción): enlace de 7 días (solo su hash) y texto sin nada clínico; abrir no lo gasta, descargar sí y lleva la nota', async () => {
    const orderId = await order();
    const res = await send(orderId).expect(200);
    const sent = res.body as Sent;
    expect(sent).toMatchObject({
      channel: 'WHATSAPP',
      destinationMasked: '••• 4567',
      recipientKind: 'PATIENT',
    });
    expect(
      (Date.parse(sent.expiresAt) - Date.parse(sent.sentAt)) / 3_600_000,
    ).toBe(168);
    expect(sent.whatsapp!.phone).toBe('584121234567');
    expect(sent.whatsapp!.url).toMatch(
      /^https?:\/\/dx572-copia-a\.[^/]+\/orden\/copia\/[A-Za-z0-9_-]{43}$/,
    );
    expect(sent.whatsapp!.text).toContain('la referencia al especialista');
    expect(sent.whatsapp!.text).not.toMatch(/percusión|ATM|temporomandibular/);
    const token = tokenOf(sent.whatsapp!.url);
    const [link] = await raw.externalOrderCopyLink.findMany({
      where: { orderId },
    });
    expect(link.tokenHash).toBe(hashPublicLinkToken(token));
    expect(JSON.stringify(link)).not.toContain(token);

    for (let i = 0; i < 2; i++) {
      const page = await open(clinicA.host, token).expect(200);
      expect(page.headers['cache-control']).toContain('no-store');
      expect(page.body as PublicCopy).toMatchObject({
        status: 'AVAILABLE',
        kind: 'SPECIALIST',
        numberLabel: '000001',
        format: { timeZone: 'America/Caracas' },
      });
      expect(JSON.stringify(page.body)).not.toMatch(
        /percusión|Especialista en/,
      );
    }
    const pdf = await download(clinicA.host, token).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('attachment');
    const text = pdfTextLines(pdf.body as Buffer).join('\n');
    expect(text).toContain('REFERENCIA A ESPECIALISTA');
    expect(text).toContain(NOTE);

    const again = await download(clinicA.host, token).expect(410);
    expect(
      JSON.parse((again.body as Buffer).toString()) as object,
    ).toMatchObject({
      code: EXTERNAL_ORDER_COPY_USED_CODE,
    });
    await expect(open(clinicA.host, token)).resolves.toMatchObject({
      status: 200,
      body: { status: 'USED' },
    });

    const events = await raw.auditEvent.findMany({
      where: { resourceId: orderId, resourceType: 'EXTERNAL_ORDER' },
      orderBy: { occurredAt: 'asc' },
    });
    const byAction = (action: string) =>
      events.filter((e) => e.action === action);
    expect(byAction('SEND')[0]).toMatchObject({
      metadata: { reason: 'EXTERNAL_ORDER_COPY_SENT' },
    });
    expect(byAction('VIEW').filter((e) => e.actorUserId === null)).toHaveLength(
      3,
    );
    expect(byAction('EXPORT')).toEqual([
      expect.objectContaining({
        actorUserId: null,
        patientId,
        metadata: {
          origin: 'PUBLIC_LINK',
          reason: 'EXTERNAL_ORDER_COPY_DOWNLOADED',
        },
      }),
    ]);
  });

  it('por email: sale por el outbox (external-order-copy) al email del paciente, sin enlace en la respuesta', async () => {
    const orderId = await order();
    const res = await send(orderId, 'EMAIL').expect(200);
    expect(res.body).toMatchObject({
      channel: 'EMAIL',
      destinationMasked: 'ma***@example.com',
      recipientKind: 'PATIENT',
      whatsapp: null,
    });
    const link = await raw.externalOrderCopyLink.findFirstOrThrow({
      where: { orderId },
    });
    expect(link.channel).toBe('EMAIL');
    const mail = await raw.emailOutbox.findFirstOrThrow({
      where: { referenceId: link.id },
    });
    expect(mail).toMatchObject({
      tenantId: clinicA.tenantId,
      template: 'EXTERNAL_ORDER_COPY',
      toMasked: 'ma***@example.com',
    });
  });

  it('reenviar invalida el anterior; anular la orden invalida el vivo y ya no se envía (409)', async () => {
    const orderId = await order();
    const first = await whatsAppToken(orderId);
    const second = await whatsAppToken(orderId);
    await open(clinicA.host, first).expect(404);
    await download(clinicA.host, first).expect(404);
    await open(clinicA.host, second).expect(200);
    await as(clinicA, dentistToken)
      .post(`/external-orders/${orderId}/void`, {
        reason: 'Estudio equivocado',
      })
      .expect(200);
    await open(clinicA.host, second).expect(404);
    const res = await send(orderId).expect(409);
    expect((res.body as { message: string }).message).toBe(
      'La orden está anulada: no se envía al paciente.',
    );
  });

  it('con el resultado ligado también se envía', async () => {
    const orderId = await order();
    const doc = await raw.patientDocument.create({
      data: {
        tenantId: clinicA.tenantId,
        patientId,
        locationId: (
          await raw.location.findFirstOrThrow({
            where: { tenantId: clinicA.tenantId },
          })
        ).id,
        category: 'REPORT',
        originalName: 'informe.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        sha256: 'a'.repeat(63) + '1',
        storageKey: 'e2e/informe-copia.pdf',
        uploadedById: clinicA.adminUserId,
      },
    });
    await as(clinicA, receptionToken)
      .post(`/external-orders/${orderId}/result`, { documentId: doc.id })
      .expect(200);
    await send(orderId).expect(200);
  });

  it('sin email: 422 que habla de la orden; un menor sin responsable: 422', async () => {
    const noEmail = await newPatient('Luisa', { email: undefined });
    const orderId = await order(noEmail);
    const res = await send(orderId, 'EMAIL').expect(422);
    expect((res.body as { message: string }).message).toBe(
      'El paciente no tiene email: añádelo en su ficha o envíala por WhatsApp.',
    );
    const minor = await newPatient('Sofía', { birthDate: '2016-03-01' });
    const minorOrder = await order(minor);
    const minorRes = await send(minorOrder).expect(422);
    expect((minorRes.body as { message: string }).message).toMatch(
      /menor de edad: registra en su ficha un responsable/,
    );
  });

  it('inventado o mal formado: 404; archivar al paciente (DX-461) invalida el enlace y lo cuenta', async () => {
    await open(clinicA.host, 'x'.repeat(43)).expect(404);
    await download(clinicA.host, 'corto').expect(404);
    const other = await newPatient('Carmen');
    const orderId = await order(other);
    const token = await whatsAppToken(orderId);
    await expect(
      as(clinicA).get(`/patients/${other}/live-public-links`),
    ).resolves.toMatchObject({
      status: 200,
      body: { externalOrderCopies: 1, total: 1 },
    });
    await raw.patient.update({
      where: { id: other },
      data: { deletedAt: new Date() },
    });
    await open(clinicA.host, token).expect(404);
    await download(clinicA.host, token).expect(404);
  });

  describe('aislamiento entre clínicas', () => {
    let orderId: string;
    let token: string;

    beforeAll(async () => {
      orderId = await order();
      token = await whatsAppToken(orderId);
    });

    // ISOLATION_COVERS: POST /external-orders/:id/patient-copy
    it('B no envía la copia de una orden de A y no se crea enlace', async () => {
      const before = await raw.externalOrderCopyLink.count();
      await send(orderId, 'WHATSAPP', clinicB).expect(404);
      expect(await raw.externalOrderCopyLink.count()).toBe(before);
    });

    // ISOLATION_COVERS: GET /public/external-order-copies/:token
    // ISOLATION_COVERS: POST /public/external-order-copies/:token/download
    it('el enlace de A en el host de B: 404 al abrir y al descargar, y no se gasta', async () => {
      await open(clinicB.host, token).expect(404);
      await download(clinicB.host, token).expect(404);
      await expect(open(clinicA.host, token)).resolves.toMatchObject({
        status: 200,
        body: { status: 'AVAILABLE' },
      });
    });
  });
});
