import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { CapturingMailer } from './support/capture-mailer';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { hashPostOpToken } from '../src/modules/post-op-instructions/domain/postop-token';
import {
  POSTOP_NO_EMAIL_MESSAGE,
  POSTOP_OPTED_OUT_MESSAGE,
} from '../src/modules/post-op-instructions/application/use-cases/post-op-deliveries.use-cases';

// DX-222 en HTTP real: sugerencias de indicaciones por cita, entrega impresa,
// por email (outbox, al responsable si es menor) y por enlace de WhatsApp,
// texto congelado con la versión de la plantilla, historial en la ficha del
// paciente y aislamiento entre clínicas. DIRECT_URL (superusuario, sin RLS)
// solo marca una baja y lee filas, el outbox y la auditoría.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const EXO_BODY =
  'Hola {{paciente}}: muerde la gasa 30 minutos. Te atendió {{profesional}} en {{clinica}}. Dudas: {{telefono_sede}}.';
const ADULT_EMAIL = 'carolina.duque@example.com';

interface Summary {
  id: string;
  patientId: string;
  appointmentId: string;
  templateId: string;
  templateCode: string;
  templateTitle: string;
  templateVersion: number;
  channel: 'PRINT' | 'EMAIL' | 'WHATSAPP_LINK';
  deliveredAt: string;
  deliveredByName: string;
  recipientMasked: string | null;
  sentToResponsible: boolean;
  firstOpenedAt: string | null;
  linkExpiresAt: string | null;
}

interface Created {
  delivery: Summary;
  publicUrl: string | null;
  whatsapp: { phone: string; text: string } | null;
  sentTo: string | null;
  sentToResponsible: boolean;
  emailQueued: boolean;
}

interface Suggestions {
  patientId: string;
  suggested: Array<{
    id: string;
    code: string;
    title: string;
    version: number;
  }>;
  others: Array<{ id: string; code: string; title: string; version: number }>;
  email: {
    allowed: boolean;
    reason: string | null;
    toMasked: string | null;
    toResponsible: boolean;
  };
  whatsapp: { phone: string | null; reason: string | null };
  locationPhone: string | null;
  deliveries: Summary[];
}

type Document = Summary & {
  renderedText: string;
  clinic: { name: string; logoUrl: string | null; primaryColor: string | null };
  locationName: string;
  locationPhone: string | null;
  patientName: string;
};

describe('Entregas de indicaciones postoperatorias (e2e, DX-222)', () => {
  let app: INestApplication<App>;
  let dispatcher: EmailDispatcher;
  const mailer = new CapturingMailer();
  let clinicA: Clinic;
  let clinicB: Clinic;
  let reception: string;
  let dentist: string;
  let dentistUserId: string;
  let typeId: string;
  let exoId: string;
  let otherTemplateId: string;
  let patientId: string;
  let appointmentId: string;
  let slot = 0;

  const as = (clinic: Clinic, token = clinic.adminToken) => {
    const set = (req: request.Test) =>
      req
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
    const server = () => request(app.getHttpServer());
    return {
      get: (path: string) => set(server().get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        set(server().post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object = {}) =>
        set(server().patch(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        set(server().put(`/api/v1${path}`)).send(body),
      delete: (path: string) => set(server().delete(`/api/v1${path}`)),
    };
  };

  async function patient(body: object): Promise<string> {
    const res = await as(clinicA)
      .post('/patients', { docType: 'CC', sex: 'F', ...body })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /** Cita de hoy (a futuro: no se agenda en el pasado), sin solaparse. */
  async function appointment(
    forPatient: string,
    appointmentTypeId?: string,
  ): Promise<string> {
    const start = new Date(Date.now() + (10 + 30 * slot++) * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const res = await as(clinicA)
      .post('/appointments', {
        patientId: forPatient,
        providerId: dentistUserId,
        start: start.toISOString(),
        end: end.toISOString(),
        ...(appointmentTypeId ? { appointmentTypeId } : {}),
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  const deliver = (
    token: string,
    appt: string,
    channel: Summary['channel'],
    templateId = exoId,
  ) =>
    as(clinicA, token).post(
      `/appointments/${appt}/post-op-instructions/deliveries`,
      { templateId, channel },
    );

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
      },
    });
    dispatcher = app.get(EmailDispatcher);
    clinicA = await registerClinic(app, 'dx222-entregas-a');
    clinicB = await registerClinic(app, 'dx222-entregas-b');
    const receptionist = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    reception = await loginAs(app, clinicA.host, receptionist.email);
    const doctor = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    dentist = await loginAs(app, clinicA.host, doctor.email);
    dentistUserId = doctor.userId;

    // Sin horario de atención: la cita se puede agendar a cualquier hora.
    await as(clinicA).put('/locations/schedule', { ranges: [] }).expect(200);
    const location = await raw.location.findFirstOrThrow({
      where: { tenantId: clinicA.tenantId },
    });
    await as(clinicA)
      .patch(`/locations/${location.id}`, { phone: '601 555 0101' })
      .expect(200);

    const type = await as(clinicA)
      .post('/appointment-types', {
        name: 'Cirugía oral',
        durationMinutes: 30,
        color: '#0E7490',
      })
      .expect(201);
    typeId = (type.body as { id: string }).id;
    const exo = await as(clinicA)
      .post('/post-op-templates', {
        code: 'POI-EXO',
        title: 'Exodoncia',
        body: EXO_BODY,
        appointmentTypeIds: [typeId],
      })
      .expect(201);
    exoId = (exo.body as { id: string }).id;
    const other = await as(clinicA)
      .post('/post-op-templates', {
        code: 'POI-PROF',
        title: 'Profilaxis',
        body: 'Evita comer durante una hora, {{paciente}}.',
      })
      .expect(201);
    otherTemplateId = (other.body as { id: string }).id;

    patientId = await patient({
      firstName: 'Carolina',
      lastName: 'Duque',
      email: ADULT_EMAIL,
      phone: '+57 310 123 4567',
      birthDate: '1990-05-01',
    });
    appointmentId = await appointment(patientId, typeId);
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('sugiere la plantilla vinculada al tipo de la cita, con el email permitido', async () => {
    const res = await as(clinicA, reception)
      .get(`/appointments/${appointmentId}/post-op-instructions`)
      .expect(200);
    const view = res.body as Suggestions;
    expect(view).toEqual({
      patientId,
      suggested: [
        { id: exoId, code: 'POI-EXO', title: 'Exodoncia', version: 1 },
      ],
      others: [
        {
          id: otherTemplateId,
          code: 'POI-PROF',
          title: 'Profilaxis',
          version: 1,
        },
      ],
      email: {
        allowed: true,
        reason: null,
        toMasked: 'ca***@example.com',
        toResponsible: false,
      },
      whatsapp: { phone: '573101234567', reason: null },
      locationPhone: '601 555 0101',
      deliveries: [],
    });
    const audit = await raw.auditEvent.findFirstOrThrow({
      where: {
        tenantId: clinicA.tenantId,
        resourceType: 'POSTOP_DELIVERY',
        action: 'VIEW',
      },
    });
    expect(audit.patientId).toBe(patientId);
  });

  it('una cita sin vínculos que coincidan no sugiere nada', async () => {
    const bare = await appointment(patientId);
    const res = await as(clinicA, dentist)
      .get(`/appointments/${bare}/post-op-instructions`)
      .expect(200);
    const view = res.body as Suggestions;
    expect(view.suggested).toEqual([]);
    expect(view.others.map((t) => t.code)).toEqual(['POI-EXO', 'POI-PROF']);
  });

  it('PRINT por recepción: 201, sin enlace, con el texto renderizado y auditado', async () => {
    const res = await deliver(reception, appointmentId, 'PRINT').expect(201);
    const created = res.body as Created;
    expect(created).toMatchObject({
      publicUrl: null,
      whatsapp: null,
      sentTo: null,
      sentToResponsible: false,
      emailQueued: false,
      delivery: {
        patientId,
        appointmentId,
        templateId: exoId,
        templateCode: 'POI-EXO',
        templateTitle: 'Exodoncia',
        templateVersion: 1,
        channel: 'PRINT',
        deliveredByName: 'Miembro RECEPTION',
        recipientMasked: null,
        firstOpenedAt: null,
        linkExpiresAt: null,
      },
    });
    const row = await raw.postOpInstructionDelivery.findUniqueOrThrow({
      where: { id: created.delivery.id },
    });
    expect(row.tokenHash).toBeNull();
    expect(row.renderedText).toBe(
      'Hola Carolina Duque: muerde la gasa 30 minutos. Te atendió Miembro DENTIST en Clinica dx222-entregas-a. Dudas: 601 555 0101.',
    );
    const audit = await raw.auditEvent.findFirstOrThrow({
      where: {
        tenantId: clinicA.tenantId,
        resourceType: 'POSTOP_DELIVERY',
        action: 'CREATE',
        resourceId: created.delivery.id,
      },
    });
    expect(audit.patientId).toBe(patientId);
    expect(audit.metadata).toMatchObject({ reason: 'PRINT' });
    expect(JSON.stringify(audit.metadata)).not.toContain('gasa');
  });

  it('EMAIL por el odontólogo: encola un email con el enlace y sin el procedimiento', async () => {
    mailer.clear();
    const res = await deliver(dentist, appointmentId, 'EMAIL').expect(201);
    const created = res.body as Created;
    expect(created.sentTo).toBe('ca***@example.com');
    expect(created.sentToResponsible).toBe(false);
    expect(created.emailQueued).toBe(true);
    expect(created.delivery.recipientMasked).toBe('ca***@example.com');
    expect(created.publicUrl).toMatch(
      /^https?:\/\/dx222-entregas-a\.[^/]+\/indicaciones\/[A-Za-z0-9_-]{43}$/,
    );
    const token = (created.publicUrl ?? '').split('/').pop() ?? '';
    const row = await raw.postOpInstructionDelivery.findUniqueOrThrow({
      where: { id: created.delivery.id },
    });
    expect(row.tokenHash).toBe(hashPostOpToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.tokenExpiresAt?.toISOString()).toBe(
      created.delivery.linkExpiresAt,
    );

    await dispatcher.whenIdle();
    await mailer.waitFor(ADULT_EMAIL, /\/indicaciones\//);
    const email = mailer.sent.find((m) => m.to === ADULT_EMAIL);
    expect(email?.subject).toBe('Indicaciones de Clinica dx222-entregas-a');
    expect(email?.text).toContain(created.publicUrl);
    for (const part of [email?.subject, email?.html, email?.text]) {
      expect(part).not.toContain('Exodoncia');
      expect(part).not.toContain('gasa');
    }
    const outbox = await raw.emailOutbox.findFirstOrThrow({
      where: { tenantId: clinicA.tenantId, referenceId: created.delivery.id },
    });
    expect(outbox.template).toBe('POST_OP_INSTRUCTIONS');
  });

  it('WHATSAPP_LINK: número wa.me y texto con el enlace, sin el procedimiento', async () => {
    const res = await deliver(reception, appointmentId, 'WHATSAPP_LINK').expect(
      201,
    );
    const created = res.body as Created;
    expect(created.whatsapp?.phone).toBe('573101234567');
    expect(created.whatsapp?.text).toContain(created.publicUrl);
    expect(created.whatsapp?.text).toContain('Hola Carolina');
    expect(created.whatsapp?.text).not.toContain('Exodoncia');
    expect(created.emailQueued).toBe(false);
    expect(created.delivery.recipientMasked).toBe('********4567');
    expect(created.delivery.linkExpiresAt).not.toBeNull();
  });

  it('editar la plantilla a v2 y entregar de nuevo: el historial guarda v1 y v2 con su texto', async () => {
    await as(clinicA)
      .patch(`/post-op-templates/${exoId}`, {
        body: 'Versión 2 para {{paciente}}: no escupas.',
      })
      .expect(200);
    const res = await deliver(reception, appointmentId, 'PRINT').expect(201);
    expect((res.body as Created).delivery.templateVersion).toBe(2);

    const list = await as(clinicA, reception)
      .get(`/patients/${patientId}/post-op-deliveries`)
      .expect(200);
    const rows = list.body as Summary[];
    expect(rows.map((r) => [r.channel, r.templateVersion])).toEqual([
      ['PRINT', 2],
      ['WHATSAPP_LINK', 1],
      ['EMAIL', 1],
      ['PRINT', 1],
    ]);
    const deliveredAt = rows.map((r) => Date.parse(r.deliveredAt));
    expect([...deliveredAt].sort((x, y) => y - x)).toEqual(deliveredAt);

    const v2 = await as(clinicA, reception)
      .get(`/patients/${patientId}/post-op-deliveries/${rows[0].id}`)
      .expect(200);
    const v1 = await as(clinicA, dentist)
      .get(`/patients/${patientId}/post-op-deliveries/${rows[3].id}`)
      .expect(200);
    const docV2 = v2.body as Document;
    const docV1 = v1.body as Document;
    expect(docV2.renderedText).toBe(
      'Versión 2 para Carolina Duque: no escupas.',
    );
    expect(docV1.renderedText).toContain('muerde la gasa');
    expect(docV1).toMatchObject({
      templateVersion: 1,
      clinic: { name: 'Clinica dx222-entregas-a' },
      locationName: 'Sede principal',
      locationPhone: '601 555 0101',
      patientName: 'Carolina Duque',
    });

    const suggestions = await as(clinicA, reception)
      .get(`/appointments/${appointmentId}/post-op-instructions`)
      .expect(200);
    expect(
      (suggestions.body as Suggestions).deliveries.map((d) => d.id),
    ).toEqual(rows.map((r) => r.id));
  });

  it('host manipulado: imprimir sigue funcionando; EMAIL y WhatsApp dan 400 «Host no válido» sin registrar nada', async () => {
    const evil = `${clinicA.host}:3001@evil.com`;
    const post = (channel: Summary['channel']) =>
      request(app.getHttpServer())
        .post(
          `/api/v1/appointments/${appointmentId}/post-op-instructions/deliveries`,
        )
        .set('X-Tenant-Host', evil)
        .set('Authorization', `Bearer ${reception}`)
        .send({ templateId: exoId, channel });
    const before = await raw.postOpInstructionDelivery.count();
    for (const channel of ['EMAIL', 'WHATSAPP_LINK'] as const) {
      const res = await post(channel).expect(400);
      expect((res.body as { message: string }).message).toBe('Host no válido');
      expect(JSON.stringify(res.body)).not.toContain('evil.com/');
    }
    expect(await raw.postOpInstructionDelivery.count()).toBe(before);
    const printed = await post('PRINT').expect(201);
    expect((printed.body as Created).publicUrl).toBeNull();
  });

  it('EMAIL a un paciente sin email ni responsable: 422', async () => {
    const id = await patient({ firstName: 'Sin', lastName: 'Correo' });
    const appt = await appointment(id);
    const res = await deliver(reception, appt, 'EMAIL').expect(422);
    expect((res.body as { message: string }).message).toBe(
      POSTOP_NO_EMAIL_MESSAGE,
    );
    expect(
      await raw.postOpInstructionDelivery.count({ where: { patientId: id } }),
    ).toBe(0);
  });

  it('EMAIL y WhatsApp a un paciente dado de baja de los envíos: 422', async () => {
    const id = await patient({
      firstName: 'Dado',
      lastName: 'Debaja',
      email: 'baja@example.com',
      phone: '+57 310 999 0000',
    });
    await raw.patient.update({
      where: { id },
      data: { reminderOptOutAt: new Date(), reminderOptOutSource: 'STAFF' },
    });
    const appt = await appointment(id);
    for (const channel of ['EMAIL', 'WHATSAPP_LINK'] as const) {
      const res = await deliver(reception, appt, channel).expect(422);
      expect((res.body as { message: string }).message).toBe(
        POSTOP_OPTED_OUT_MESSAGE,
      );
    }
    await deliver(reception, appt, 'PRINT').expect(201);
  });

  it('EMAIL de un menor: va a su responsable que recibe avisos', async () => {
    const id = await patient({
      firstName: 'Tomás',
      lastName: 'Ortiz',
      docType: 'TI',
      sex: 'M',
      birthDate: '2016-04-10',
    });
    await as(clinicA, reception)
      .post(`/patients/${id}/responsible-parties`, {
        fullName: 'Claudia Navarro',
        email: 'claudia.navarro@example.com',
        relationship: 'MOTHER',
        isPayer: true,
      })
      .expect(201);
    const appt = await appointment(id);
    const suggestions = await as(clinicA, reception)
      .get(`/appointments/${appt}/post-op-instructions`)
      .expect(200);
    expect((suggestions.body as Suggestions).email).toEqual({
      allowed: true,
      reason: null,
      toMasked: 'cl***@example.com',
      toResponsible: true,
    });

    mailer.clear();
    const res = await deliver(reception, appt, 'EMAIL').expect(201);
    expect(res.body as Created).toMatchObject({
      sentTo: 'cl***@example.com',
      sentToResponsible: true,
      delivery: { sentToResponsible: true },
    });
    await dispatcher.whenIdle();
    await mailer.waitFor(
      'claudia.navarro@example.com',
      /indicaciones de cuidado de Tomás/,
    );
  });

  describe('desde la clínica B', () => {
    it('la cita, el paciente y la entrega de A no existen (404)', async () => {
      const list = await as(clinicA)
        .get(`/patients/${patientId}/post-op-deliveries`)
        .expect(200);
      const deliveryId = (list.body as Summary[])[0].id;
      const before = await raw.postOpInstructionDelivery.count();

      await as(clinicB)
        .get(`/appointments/${appointmentId}/post-op-instructions`)
        .expect(404);
      await as(clinicB)
        .post(
          `/appointments/${appointmentId}/post-op-instructions/deliveries`,
          {
            templateId: exoId,
            channel: 'PRINT',
          },
        )
        .expect(404);
      await as(clinicB)
        .get(`/patients/${patientId}/post-op-deliveries`)
        .expect(404);
      await as(clinicB)
        .get(`/patients/${patientId}/post-op-deliveries/${deliveryId}`)
        .expect(404);
      expect(await raw.postOpInstructionDelivery.count()).toBe(before);
    });
  });

  it('una entrega no se edita ni se borra: no hay PATCH ni DELETE', async () => {
    const list = await as(clinicA)
      .get(`/patients/${patientId}/post-op-deliveries`)
      .expect(200);
    const deliveryId = (list.body as Summary[])[0].id;
    const path = `/patients/${patientId}/post-op-deliveries/${deliveryId}`;
    const patch = await as(clinicA).patch(path, { renderedText: 'x' });
    const del = await as(clinicA).delete(path);
    expect([404, 405]).toContain(patch.status);
    expect([404, 405]).toContain(del.status);
    const row = await raw.postOpInstructionDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });
    expect(row.renderedText).not.toBe('x');
  });

  it('una plantilla inactiva no se entrega (400) y una inexistente da 404', async () => {
    await as(clinicA)
      .patch(`/post-op-templates/${otherTemplateId}`, { active: false })
      .expect(200);
    await deliver(reception, appointmentId, 'PRINT', otherTemplateId).expect(
      400,
    );
    await deliver(
      reception,
      appointmentId,
      'PRINT',
      '00000000-0000-4000-8000-000000000000',
    ).expect(404);
  });
  it('sugiere por un procedimiento hecho en la cita (evolución ligada a ella)', async () => {
    const item = await as(clinicA)
      .post('/catalog/items', {
        code: 'IMP-222',
        kind: 'PROCEDURE',
        labelEs: 'Implante',
        color: '#2A2B3C',
      })
      .expect(201);
    const catalogItemId = (item.body as { id: string }).id;
    const implant = await as(clinicA)
      .post('/post-op-templates', {
        code: 'POI-IMP',
        title: 'Implante',
        body: 'No fumes, {{paciente}}.',
        catalogItemIds: [catalogItemId],
      })
      .expect(201);
    const appt = await appointment(patientId);
    // La evolución no se liga a una cita de un día civil futuro, y la de
    // `appointment()` cae mañana si el spec corre al final del día en
    // Bogotá: se pasa a la hora anterior (agendar en el pasado no se puede
    // por la API).
    await raw.appointment.update({
      where: { id: appt },
      data: {
        start: new Date(Date.now() - 60 * 60 * 1000),
        end: new Date(Date.now() - 30 * 60 * 1000),
      },
    });
    const before = await as(clinicA, dentist)
      .get(`/appointments/${appt}/post-op-instructions`)
      .expect(200);
    const implantId = (implant.body as { id: string }).id;
    expect((before.body as Suggestions).suggested).toEqual([]);

    const entry = await as(clinicA, dentist)
      .post(`/patients/${patientId}/clinical-entries`, {
        notes: 'Colocación de implante.',
        appointmentId: appt,
      })
      .expect(201);
    await as(clinicA, dentist)
      .post(`/patients/${patientId}/tooth-records`, {
        toothNumber: '36',
        kind: 'PROCEDURE',
        catalogItemId,
        status: 'COMPLETED',
        clinicalEntryId: (entry.body as { id: string }).id,
      })
      .expect(201);

    const after = await as(clinicA, dentist)
      .get(`/appointments/${appt}/post-op-instructions`)
      .expect(200);
    expect((after.body as Suggestions).suggested.map((t) => t.id)).toEqual([
      implantId,
    ]);
  });
});
