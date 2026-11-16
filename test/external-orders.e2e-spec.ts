import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { pdfTextLines } from '../src/modules/consents/infrastructure/pdf/__fixtures__/pdf-text';
import { LOCATION_NOT_ALLOWED_CODE } from '../src/shared/tenancy/location-access';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationBody,
} from './support/location-fixtures';

// DX-572 en HTTP real: órdenes de estudios y referencias externas. Emitir
// (DENTIST/ADMIN con registro; recepción 403), listar, PDF con y sin la nota
// (recepción 403 con withNote), anular con «ANULADA» archivado, ligar y
// desligar el resultado, «Órdenes sin resultado» con el plazo de la clínica,
// sede no permitida (403), aislamiento entre clínicas (404), plantillas con
// versión y auditoría sin la nota, los estudios ni el destinatario.
// DIRECT_URL (superusuario, sin RLS) siembra lo que la API no expone y lee
// lo guardado.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const NOTE = 'Dolor a la percusión en el 36, sospecha de lesión periapical';
const RECIPIENT = 'Centro de Imagen del Este';

interface Order {
  id: string;
  patientId: string;
  locationId: string;
  appointmentId: string | null;
  kind: string;
  status: 'ISSUED' | 'RESULT_RECEIVED' | 'VOIDED';
  number: number;
  numberLabel: string;
  recipient: string;
  items: string[];
  toothNumbers: string[];
  clinicalNote: string | null;
  hasClinicalNote: boolean;
  templateId: string | null;
  documentId: string | null;
  resultDocumentId: string | null;
  resultLinkedById: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  voidedDocumentId: string | null;
  snapshot: {
    patient: { name: string; document: string | null; ageYears: number | null };
    professional: { name: string; license: string | null };
    location: { timeZone: string };
  };
}

interface Pending {
  overdueDays: number;
  total: number;
  items: {
    order: Order;
    patient: { id: string };
    ageDays: number;
    overdue: boolean;
  }[];
}

interface Template {
  id: string;
  name: string;
  kind: string;
  recipient: string | null;
  items: string[];
  active: boolean;
  version: number;
}

interface ErrorBody {
  message: string;
  code?: string;
}

const body = (over: object = {}) => ({
  kind: 'IMAGING',
  recipient: RECIPIENT,
  items: ['Radiografía panorámica', 'Periapical del 36'],
  toothNumbers: ['36'],
  clinicalNote: NOTE,
  ...over,
});

const binary = (r: request.Response, cb: (e: null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  r.on('data', (c: Buffer) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('Órdenes de estudios y referencias externas (e2e, DX-572)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let locationA: string;
  let patientId: string;
  let patientB: string;
  let receptionToken: string;
  let receptionUserId: string;
  let dentistToken: string;
  let dentistUserId: string;
  let assistantToken: string;
  let assistantUserId: string;
  let assistantEmail: string;

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
      put: (path: string, payload: object = {}) =>
        set(server().put(`/api/v1${path}`)).send(payload),
      patch: (path: string, payload: object = {}) =>
        set(server().patch(`/api/v1${path}`)).send(payload),
    };
  };

  const issue = (
    over: object = {},
    token = dentistToken,
    clinic = clinicA,
    patient = patientId,
  ) =>
    as(clinic, token).post(`/patients/${patient}/external-orders`, body(over));

  const issued = async (over: object = {}): Promise<Order> =>
    (await issue(over).expect(201)).body as Order;

  /** Un documento vivo del paciente (la radiografía del resultado). */
  const document = async (clinic = clinicA, patient = patientId) =>
    (
      await raw.patientDocument.create({
        data: {
          tenantId: clinic.tenantId,
          patientId: patient,
          locationId:
            clinic === clinicA
              ? locationA
              : (
                  await raw.location.findFirstOrThrow({
                    where: { tenantId: clinic.tenantId },
                  })
                ).id,
          category: 'XRAY',
          originalName: 'panoramica.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 10,
          sha256:
            `${Math.random().toString(16).slice(2).padEnd(64, '0')}`.slice(
              0,
              64,
            ),
          storageKey: `e2e/${Math.random().toString(36).slice(2)}.jpg`,
          uploadedById: clinic.adminUserId,
        },
        select: { id: true },
      })
    ).id;

  const pdf = (path: string, token = dentistToken) =>
    as(clinicA, token).get(path).buffer(true).parse(binary);

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    clinicA = await registerClinic(app, 'dx572-ord-a');
    clinicB = await registerClinic(app, 'dx572-ord-b');
    locationA = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).id;
    const created = await as(clinicA)
      .post('/patients', {
        docType: 'NATIONAL_ID',
        docNumber: '12345678',
        sex: 'F',
        firstName: 'Mariela',
        lastName: 'Rondón',
        birthDate: '1985-06-20',
      })
      .expect(201);
    patientId = (created.body as { id: string }).id;
    patientB = (
      (
        await as(clinicB)
          .post('/patients', {
            docType: 'NATIONAL_ID',
            docNumber: '87654321',
            sex: 'M',
            firstName: 'Pedro',
            lastName: 'Lugo',
          })
          .expect(201)
      ).body as { id: string }
    ).id;

    const reception = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    receptionUserId = reception.userId;
    receptionToken = await loginAs(app, clinicA.host, reception.email);
    const dentist = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    dentistUserId = dentist.userId;
    await raw.clinicMembership.updateMany({
      where: { tenantId: clinicA.tenantId, userId: dentist.userId },
      data: { professionalLicense: 'REG-45678' },
    });
    dentistToken = await loginAs(app, clinicA.host, dentist.email);
    const assistant = await seedMember(raw, clinicA, ClinicRole.ASSISTANT);
    assistantUserId = assistant.userId;
    assistantEmail = assistant.email;
    assistantToken = await loginAs(app, clinicA.host, assistant.email);
    // El ADMIN de B también emite (con registro) en su clínica.
    await raw.clinicMembership.updateMany({
      where: { tenantId: clinicB.tenantId, userId: clinicB.adminUserId },
      data: { professionalLicense: 'REG-B-1' },
    });
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('el odontólogo emite: número de la sede, foto, PDF archivado sin la nota (REFERRAL) y auditoría sin contenido', async () => {
    const order = await issued();
    expect(order).toMatchObject({
      kind: 'IMAGING',
      status: 'ISSUED',
      number: 1,
      numberLabel: '000001',
      recipient: RECIPIENT,
      items: ['Radiografía panorámica', 'Periapical del 36'],
      toothNumbers: ['36'],
      clinicalNote: NOTE,
      hasClinicalNote: true,
      appointmentId: null,
      locationId: locationA,
    });
    expect(order.snapshot.patient).toMatchObject({
      name: 'Mariela Rondón',
      ageYears: expect.any(Number) as number,
    });
    expect(order.snapshot.patient.document).toContain('12345678');
    expect(order.snapshot.professional.license).toBe('REG-45678');
    const doc = await raw.patientDocument.findUniqueOrThrow({
      where: { id: order.documentId! },
    });
    expect(doc).toMatchObject({
      category: 'REFERRAL',
      patientId,
      mimeType: 'application/pdf',
    });
    const event = await raw.auditEvent.findFirstOrThrow({
      where: { resourceId: order.id, action: 'CREATE' },
    });
    expect(event).toMatchObject({
      resourceType: 'EXTERNAL_ORDER',
      patientId,
      actorUserId: dentistUserId,
      metadata: { reason: 'EXTERNAL_ORDER_ISSUED' },
    });
    expect(JSON.stringify(event.metadata)).not.toMatch(
      /percusión|panorámica|Centro de Imagen/,
    );
    // La segunda de la sede lleva el siguiente número.
    expect((await issued()).number).toBe(2);
  });

  it('solo DENTIST y ADMIN emiten: recepción y auxiliar 403 en español; sin registro profesional, 400', async () => {
    for (const token of [receptionToken, assistantToken]) {
      const res = await issue({}, token).expect(403);
      expect((res.body as ErrorBody).message).toBe(
        'Solo un odontólogo o un administrador emiten órdenes de estudios y referencias.',
      );
    }
    const res = await issue({}, clinicA.adminToken).expect(400);
    expect((res.body as ErrorBody).message).toMatch(/registro profesional/);
    const invalid = await issue({
      recipient: ' ',
      items: [],
      toothNumbers: ['99'],
    }).expect(400);
    expect((invalid.body as ErrorBody).message).toMatch(
      /^No se puede emitir la orden: .*centro o el especialista.*estudios.*FDI/,
    );
  });

  it('desde una cita del paciente: la orden es de la sede de la cita; la cita de otro paciente, 404', async () => {
    const start = new Date(Date.UTC(2026, 9, 5, 13, 0));
    const appt = await raw.appointment.create({
      data: {
        tenantId: clinicA.tenantId,
        locationId: locationA,
        patientId,
        providerId: dentistUserId,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
      },
    });
    const order = await issued({ appointmentId: appt.id, kind: 'LAB' });
    expect(order).toMatchObject({ appointmentId: appt.id, kind: 'LAB' });
    const other = await raw.patient.create({
      data: {
        tenantId: clinicA.tenantId,
        firstName: 'Luis',
        lastName: 'Guerra',
      },
    });
    await issue(
      { appointmentId: appt.id },
      dentistToken,
      clinicA,
      other.id,
    ).expect(404);
  });

  it('recepción ve la lista y el detalle sin la nota, reimprime sin ella y withNote es 403; el clínico la ve', async () => {
    const order = await issued();
    const list = (
      await as(clinicA, receptionToken)
        .get(`/patients/${patientId}/external-orders`)
        .expect(200)
    ).body as Order[];
    const mine = list.find((o) => o.id === order.id)!;
    expect(mine).toMatchObject({ clinicalNote: null, hasClinicalNote: true });
    await expect(
      as(clinicA, receptionToken).get(`/external-orders/${order.id}`),
    ).resolves.toMatchObject({ status: 200, body: { clinicalNote: null } });

    const plain = await pdf(
      `/external-orders/${order.id}/pdf`,
      receptionToken,
    ).expect(200);
    expect(plain.headers['content-type']).toBe('application/pdf');
    const plainText = pdfTextLines(plain.body as Buffer).join('\n');
    expect(plainText).toContain(`Nº ${order.numberLabel}`);
    expect(plainText).not.toContain('percusión');
    const denied = await as(clinicA, receptionToken)
      .get(`/external-orders/${order.id}/pdf?withNote=true`)
      .expect(403);
    expect((denied.body as ErrorBody).message).toMatch(/nota clínica/);

    const withNote = await pdf(
      `/external-orders/${order.id}/pdf?withNote=true`,
      assistantToken,
    ).expect(200);
    expect(pdfTextLines(withNote.body as Buffer).join('\n')).toContain(
      'percusión',
    );
    const prints = await raw.auditEvent.count({
      where: { resourceId: order.id, action: 'PRINT' },
    });
    // El 403 no deja evento: dos impresiones.
    expect(prints).toBe(2);
  });

  it('anular: motivo 5–500, ADMIN o quien la emitió; «ANULADA» archivado, el PDF original anulado en la ficha', async () => {
    const order = await issued();
    await as(clinicA, dentistToken)
      .post(`/external-orders/${order.id}/void`, { reason: 'Mal' })
      .expect(400);
    await as(clinicA, receptionToken)
      .post(`/external-orders/${order.id}/void`, {
        reason: 'Estudio equivocado',
      })
      .expect(403);
    const voided = (
      await as(clinicA, dentistToken)
        .post(`/external-orders/${order.id}/void`, {
          reason: 'Estudio equivocado',
        })
        .expect(200)
    ).body as Order;
    expect(voided).toMatchObject({
      status: 'VOIDED',
      voidReason: 'Estudio equivocado',
    });
    expect(voided.voidedDocumentId).not.toBeNull();
    const original = await raw.patientDocument.findUniqueOrThrow({
      where: { id: order.documentId! },
    });
    expect(original.voidReason).toBe('Orden anulada: Estudio equivocado');
    const reprint = await pdf(`/external-orders/${order.id}/pdf`).expect(200);
    expect(pdfTextLines(reprint.body as Buffer).join('\n')).toContain(
      'ANULADA',
    );
    await as(clinicA)
      .post(`/external-orders/${order.id}/void`, { reason: 'Otra vez más' })
      .expect(409);
    const event = await raw.auditEvent.findFirstOrThrow({
      where: { resourceId: order.id, action: 'VOID' },
    });
    expect(JSON.stringify(event.metadata)).not.toContain('equivocado');
  });

  it('ligar el resultado (recepción sube y liga) la saca de pendientes; desligar: un clínico o quien la ligó', async () => {
    const order = await issued();
    const doc = await document();
    const linked = (
      await as(clinicA, receptionToken)
        .post(`/external-orders/${order.id}/result`, { documentId: doc })
        .expect(200)
    ).body as Order;
    expect(linked).toMatchObject({
      status: 'RESULT_RECEIVED',
      resultDocumentId: doc,
      resultLinkedById: receptionUserId,
      clinicalNote: null,
    });
    const pending = (
      await as(clinicA, receptionToken)
        .get(`/external-orders/pending?locationId=${locationA}`)
        .expect(200)
    ).body as Pending;
    expect(pending.items.map((i) => i.order.id)).not.toContain(order.id);
    // Ya tiene resultado: 409; anularla también (se desliga antes).
    await as(clinicA, dentistToken)
      .post(`/external-orders/${order.id}/result`, { documentId: doc })
      .expect(409);
    await as(clinicA)
      .post(`/external-orders/${order.id}/void`, {
        reason: 'Estudio equivocado',
      })
      .expect(409);
    const unlinked = (
      await as(clinicA, assistantToken)
        .post(`/external-orders/${order.id}/result/unlink`)
        .expect(200)
    ).body as Order;
    expect(unlinked).toMatchObject({
      status: 'ISSUED',
      resultDocumentId: null,
    });
    await as(clinicA, assistantToken)
      .post(`/external-orders/${order.id}/result/unlink`)
      .expect(409);
    const reasons = (
      await raw.auditEvent.findMany({
        where: { resourceId: order.id, action: 'UPDATE' },
        orderBy: { occurredAt: 'asc' },
      })
    ).map((e) => (e.metadata as { reason?: string }).reason);
    expect(reasons).toEqual([
      'EXTERNAL_ORDER_RESULT_LINKED',
      'EXTERNAL_ORDER_RESULT_UNLINKED',
    ]);
  });

  it('recepción no desliga un resultado que ligó otro (403); quien lo ligó, sí', async () => {
    const order = await issued();
    const doc = await document();
    await as(clinicA, dentistToken)
      .post(`/external-orders/${order.id}/result`, { documentId: doc })
      .expect(200);
    const denied = await as(clinicA, receptionToken)
      .post(`/external-orders/${order.id}/result/unlink`)
      .expect(403);
    expect((denied.body as ErrorBody).message).toBe(
      'Solo los roles clínicos o quien ligó el resultado pueden desligarlo.',
    );
    await as(clinicA, dentistToken)
      .post(`/external-orders/${order.id}/result`, { documentId: doc })
      .expect(409);
    // Un documento puede ser el resultado de varias órdenes.
    const second = await issued();
    await as(clinicA, receptionToken)
      .post(`/external-orders/${second.id}/result`, { documentId: doc })
      .expect(200);
    await as(clinicA, receptionToken)
      .post(`/external-orders/${second.id}/result/unlink`)
      .expect(200);
  });

  it('el resultado es un documento vivo del MISMO paciente', async () => {
    const order = await issued();
    const other = await raw.patient.create({
      data: { tenantId: clinicA.tenantId, firstName: 'Ana', lastName: 'Mora' },
    });
    const foreign = await document(clinicA, other.id);
    await as(clinicA)
      .post(`/external-orders/${order.id}/result`, { documentId: foreign })
      .expect(404);
  });

  it('«Órdenes sin resultado»: la más antigua primero, ageDays en días de la sede y vencida > N (ajuste de la clínica)', async () => {
    const old = await issued({ recipient: 'Laboratorio Clínico Central' });
    // Emitida hace 20 días (el trigger pone la hora del servidor; el owner la
    // retrocede sin el trigger de guarda).
    await raw.$executeRaw`ALTER TABLE "external_orders" DISABLE TRIGGER "external_orders_guard"`;
    try {
      await raw.$executeRaw`UPDATE "external_orders"
        SET "issuedAt" = "issuedAt" - interval '20 days' WHERE "id" = ${old.id}::uuid`;
    } finally {
      await raw.$executeRaw`ALTER TABLE "external_orders" ENABLE TRIGGER "external_orders_guard"`;
    }
    const all = (
      await as(clinicA, receptionToken)
        .get(`/external-orders/pending?locationId=${locationA}`)
        .expect(200)
    ).body as Pending;
    expect(all.overdueDays).toBe(15);
    expect(all.items[0]).toMatchObject({
      order: { id: old.id },
      ageDays: 20,
      overdue: true,
    });
    expect(all.items.every((i) => i.order.status === 'ISSUED')).toBe(true);
    expect(all.items.every((i) => i.order.clinicalNote === null)).toBe(true);
    const overdue = (
      await as(clinicA, receptionToken)
        .get(
          `/external-orders/pending?locationId=${locationA}&overdueOnly=true`,
        )
        .expect(200)
    ).body as Pending;
    expect(overdue.items.map((i) => i.order.id)).toEqual([old.id]);

    // ADMIN sube el plazo a 30: ya no está vencida. Recepción no lo cambia.
    await as(clinicA, receptionToken)
      .put('/external-orders/settings', { overdueDays: 30 })
      .expect(403);
    await as(clinicA)
      .put('/external-orders/settings', { overdueDays: 400 })
      .expect(400);
    await as(clinicA)
      .put('/external-orders/settings', { overdueDays: 30 })
      .expect(200, { overdueDays: 30 });
    const after = (
      await as(clinicA, receptionToken)
        .get(
          `/external-orders/pending?locationId=${locationA}&overdueOnly=true`,
        )
        .expect(200)
    ).body as Pending;
    expect(after).toMatchObject({ overdueDays: 30, total: 0 });
    const setting = await raw.auditEvent.findFirstOrThrow({
      where: { tenantId: clinicA.tenantId, resourceType: 'CLINIC_SETTINGS' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(setting.metadata).toMatchObject({
      reason: 'EXTERNAL_ORDER_SETTINGS',
      changedFields: ['overdueDays'],
    });
    await expect(
      as(clinicA, assistantToken).get('/external-orders/settings'),
    ).resolves.toMatchObject({ status: 200, body: { overdueDays: 30 } });
    await as(clinicA, receptionToken)
      .get('/external-orders/settings')
      .expect(403);
  });

  it('sugerencias de destinatario: las de las órdenes de la clínica, sin repetir', async () => {
    const list = (
      await as(clinicA, dentistToken)
        .get('/external-orders/recipients?q=centro')
        .expect(200)
    ).body as { name: string; source: string }[];
    expect(list).toContainEqual({ name: RECIPIENT, source: 'RECENT' });
    expect(new Set(list.map((r) => r.name.toLowerCase())).size).toBe(
      list.length,
    );
    await as(clinicA, receptionToken)
      .get('/external-orders/recipients')
      .expect(403);
  });

  it('sede no permitida: 403 LOCATION_NOT_ALLOWED en pendientes; su orden no sale ni se abre (404)', async () => {
    const otherLocation = (
      (
        await as(clinicA)
          .post(
            '/locations',
            locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Valencia' }),
          )
          .expect(201)
      ).body as { id: string }
    ).id;
    const order = (
      await as(clinicA, dentistToken)
        .post(`/patients/${patientId}/external-orders`, body())
        .set('X-Location-Id', otherLocation)
        .expect(201)
    ).body as Order;
    expect(order).toMatchObject({ locationId: otherLocation, number: 1 });
    await as(clinicA)
      .put(`/staff/${assistantUserId}/locations`, { locationIds: [locationA] })
      .expect(200);
    const token = await loginAs(app, clinicA.host, assistantEmail);
    const denied = await as(clinicA, token)
      .get(`/external-orders/pending?locationId=${otherLocation}`)
      .expect(403);
    expect((denied.body as ErrorBody).code).toBe(LOCATION_NOT_ALLOWED_CODE);
    const list = (
      await as(clinicA, token)
        .get(`/patients/${patientId}/external-orders`)
        .expect(200)
    ).body as Order[];
    expect(list.map((o) => o.id)).not.toContain(order.id);
    await as(clinicA, token).get(`/external-orders/${order.id}`).expect(404);
  });

  describe('plantillas', () => {
    it('ADMIN crea y edita con versión; los clínicos las leen; recepción no; el nombre es único sin mayúsculas', async () => {
      const created = (
        await as(clinicA)
          .post('/external-order-templates', {
            name: 'Radiografía panorámica',
            kind: 'IMAGING',
            recipient: 'Centro de Imagen del Este',
            items: ['Radiografía panorámica'],
          })
          .expect(201)
      ).body as Template;
      expect(created).toMatchObject({ active: true, version: 1 });
      await as(clinicA)
        .post('/external-order-templates', {
          name: 'radiografía  PANORÁMICA',
          kind: 'IMAGING',
          items: ['Otra'],
        })
        .expect(409)
        .expect((r) =>
          expect((r.body as ErrorBody).code).toBe(
            'EXTERNAL_ORDER_TEMPLATE_DUPLICATE_NAME',
          ),
        );
      await as(clinicA, dentistToken)
        .post('/external-order-templates', {
          name: 'Tomografía',
          kind: 'IMAGING',
          items: ['Tomografía de haz cónico'],
        })
        .expect(403);
      await as(clinicA, receptionToken)
        .get('/external-order-templates')
        .expect(403);
      const read = (
        await as(clinicA, assistantToken)
          .get('/external-order-templates')
          .expect(200)
      ).body as Template[];
      expect(read.map((t) => t.id)).toContain(created.id);

      const edited = (
        await as(clinicA)
          .patch(`/external-order-templates/${created.id}`, {
            active: false,
            version: 1,
          })
          .expect(200)
      ).body as Template;
      expect(edited).toMatchObject({ active: false, version: 2 });
      await as(clinicA)
        .patch(`/external-order-templates/${created.id}`, {
          active: true,
          version: 1,
        })
        .expect(409)
        .expect((r) =>
          expect((r.body as ErrorBody).code).toBe(
            'EXTERNAL_ORDER_TEMPLATE_STALE',
          ),
        );
      // Desactivada: no se emite con ella (409) ni sale en la lista normal.
      await issue({ templateId: created.id }).expect(409);
      const active = (
        await as(clinicA, dentistToken)
          .get('/external-order-templates')
          .expect(200)
      ).body as Template[];
      expect(active.map((t) => t.id)).not.toContain(created.id);
      await as(clinicA)
        .patch(`/external-order-templates/${created.id}`, {
          active: true,
          version: 2,
        })
        .expect(200);
      const fromTemplate = await issued({ templateId: created.id });
      expect(fromTemplate.templateId).toBe(created.id);
      // Su destinatario habitual sale primero en las sugerencias.
      const suggestions = (
        await as(clinicA, dentistToken)
          .get('/external-orders/recipients')
          .expect(200)
      ).body as { name: string; source: string }[];
      expect(suggestions[0]).toEqual({
        name: 'Centro de Imagen del Este',
        source: 'TEMPLATE',
      });
      const events = await raw.auditEvent.findMany({
        where: {
          resourceType: 'EXTERNAL_ORDER_TEMPLATE',
          resourceId: created.id,
        },
      });
      expect(
        events.map((e) => (e.metadata as { reason?: string }).reason).sort(),
      ).toEqual([
        'EXTERNAL_ORDER_TEMPLATE_CREATED',
        'EXTERNAL_ORDER_TEMPLATE_UPDATED',
        'EXTERNAL_ORDER_TEMPLATE_UPDATED',
      ]);
      expect(JSON.stringify(events.map((e) => e.metadata))).not.toContain(
        'Centro de Imagen',
      );
    });
  });

  describe('aislamiento entre clínicas', () => {
    let order: Order;
    let templateA: string;

    beforeAll(async () => {
      order = await issued();
      templateA = (
        (
          await as(clinicA)
            .post('/external-order-templates', {
              name: 'Plantilla de A',
              kind: 'LAB',
              items: ['Hematología completa'],
            })
            .expect(201)
        ).body as Template
      ).id;
    });

    // ISOLATION_COVERS: GET /patients/:patientId/external-orders
    it('B no lista las órdenes del paciente de A', async () => {
      await as(clinicB)
        .get(`/patients/${patientId}/external-orders`)
        .expect(404);
    });

    // ISOLATION_COVERS: POST /patients/:patientId/external-orders
    it('B no emite sobre el paciente de A ni con la cita o la plantilla de A', async () => {
      await issue({}, clinicB.adminToken, clinicB).expect(404);
      const appt = await raw.appointment.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId },
      });
      await issue(
        { appointmentId: appt.id },
        clinicB.adminToken,
        clinicB,
        patientB,
      ).expect(404);
      await issue(
        { templateId: templateA },
        clinicB.adminToken,
        clinicB,
        patientB,
      ).expect(404);
      expect(
        await raw.externalOrder.count({
          where: { tenantId: clinicB.tenantId },
        }),
      ).toBe(0);
    });

    // ISOLATION_COVERS: GET /external-orders/:id
    it('B no lee la orden de A', async () => {
      await as(clinicB).get(`/external-orders/${order.id}`).expect(404);
    });

    // ISOLATION_COVERS: GET /external-orders/:id/pdf
    it('B no imprime la orden de A', async () => {
      await as(clinicB).get(`/external-orders/${order.id}/pdf`).expect(404);
    });

    // ISOLATION_COVERS: POST /external-orders/:id/void
    it('B no anula la orden de A y sigue emitida', async () => {
      await as(clinicB)
        .post(`/external-orders/${order.id}/void`, {
          reason: 'Intrusa desde B',
        })
        .expect(404);
      const row = await raw.externalOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(row.status).toBe('ISSUED');
    });

    // ISOLATION_COVERS: POST /external-orders/:id/result
    it('B no liga un resultado a la orden de A, ni un documento de A a su orden', async () => {
      const docB = await document(clinicB, patientB);
      await as(clinicB)
        .post(`/external-orders/${order.id}/result`, { documentId: docB })
        .expect(404);
      const own = (
        await issue({}, clinicB.adminToken, clinicB, patientB).expect(201)
      ).body as Order;
      const docA = await document();
      await as(clinicB)
        .post(`/external-orders/${own.id}/result`, { documentId: docA })
        .expect(404);
      const row = await raw.externalOrder.findUniqueOrThrow({
        where: { id: own.id },
      });
      expect(row.status).toBe('ISSUED');
    });

    // ISOLATION_COVERS: POST /external-orders/:id/result/unlink
    it('B no desliga el resultado de la orden de A', async () => {
      const doc = await document();
      await as(clinicA)
        .post(`/external-orders/${order.id}/result`, { documentId: doc })
        .expect(200);
      await as(clinicB)
        .post(`/external-orders/${order.id}/result/unlink`)
        .expect(404);
      const row = await raw.externalOrder.findUniqueOrThrow({
        where: { id: order.id },
      });
      expect(row.status).toBe('RESULT_RECEIVED');
    });

    it('B no ve los pendientes de la sede de A (404) ni sus destinatarios', async () => {
      await as(clinicB)
        .get(`/external-orders/pending?locationId=${locationA}`)
        .expect(404);
      const list = (
        await as(clinicB).get('/external-orders/recipients').expect(200)
      ).body as { name: string }[];
      expect(list.map((r) => r.name)).not.toContain(
        'Laboratorio Clínico Central',
      );
    });

    // ISOLATION_COVERS: PATCH /external-order-templates/:id
    it('B no edita la plantilla de A', async () => {
      await as(clinicB)
        .patch(`/external-order-templates/${templateA}`, {
          name: 'Hackeada',
          version: 1,
        })
        .expect(404);
      const row = await raw.externalOrderTemplate.findUniqueOrThrow({
        where: { id: templateA },
      });
      expect(row.name).toBe('Plantilla de A');
    });
  });
});
