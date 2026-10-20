import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { CapturingMailer } from './support/capture-mailer';
import {
  type Clinic,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { POSTOP_CLOCK } from '../src/modules/post-op-instructions/application/post-op-clock';
import {
  POSTOP_LINK_EXPIRED_MESSAGE,
  POSTOP_LINK_NOT_FOUND_MESSAGE,
} from '../src/modules/post-op-instructions/application/use-cases/public-post-op.use-cases';

// DX-222 en HTTP real: la página pública de indicaciones que abre el paciente
// desde el email (sin sesión, la clínica sale del host). Muestra el texto
// congelado con la marca de la clínica, registra solo la primera apertura y
// caduca a los 30 días. El reloj del módulo se sobrescribe para adelantarlo.
// DIRECT_URL (superusuario, sin RLS) solo lee la fila de la entrega.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// Sin `{{paciente}}`: así el cuerpo de la página no lleva el apellido y se
// puede comprobar que el JSON no lo filtra por su cuenta.
const BODY =
  'Muerde la gasa 30 minutos. Te atendió {{profesional}} en {{clinica}}. Dudas: {{telefono_sede}}.';
const EMAIL = 'mariana.zuluaga@example.com';
const LAST_NAME = 'Zuluagarrestrepo';
const DOC_NUMBER = '1098765432';
const DAY_MS = 24 * 60 * 60 * 1000;

interface PublicPostOp {
  clinic: { name: string; logoUrl: string | null; primaryColor: string | null };
  locationPhone: string | null;
  title: string;
  code: string;
  version: number;
  renderedText: string;
  deliveredAt: string;
}

describe('Indicaciones postoperatorias por enlace público (e2e, DX-222)', () => {
  let app: INestApplication<App>;
  const mailer = new CapturingMailer();
  let offsetMs = 0;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let patientId: string;
  let deliveryId: string;
  let token: string;

  const server = () => request(app.getHttpServer());
  const as = (clinic: Clinic) => {
    const set = (req: request.Test) =>
      req
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`);
    return {
      get: (path: string) => set(server().get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        set(server().post(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        set(server().put(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) =>
        set(server().patch(`/api/v1${path}`)).send(body),
    };
  };
  // Lo que hace el navegador del paciente: sin sesión, solo el host.
  const publicGet = (host: string, t: string) =>
    server()
      .get(`/api/v1/public/post-op-instructions/${t}`)
      .set('X-Tenant-Host', host);
  const publicOpened = (host: string, t: string) =>
    server()
      .post(`/api/v1/public/post-op-instructions/${t}/opened`)
      .set('X-Tenant-Host', host);

  const deliveryRow = () =>
    raw.postOpInstructionDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
    });

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
        builder
          .overrideProvider(POSTOP_CLOCK)
          .useValue(() => new Date(Date.now() + offsetMs));
      },
    });
    clinicA = await registerClinic(app, 'dx222-publica-a');
    clinicB = await registerClinic(app, 'dx222-publica-b');

    const dentist = await seedMember(raw, clinicA, ClinicRole.DENTIST);

    // Sin horario de atención: la cita se puede agendar a cualquier hora.
    await as(clinicA)
      .put('/locations/schedule', { timezone: 'America/Bogota', ranges: [] })
      .expect(200);
    const location = await raw.location.findFirstOrThrow({
      where: { tenantId: clinicA.tenantId },
    });
    await as(clinicA)
      .patch(`/locations/${location.id}`, { phone: '601 555 0101' })
      .expect(200);

    const template = await as(clinicA)
      .post('/post-op-templates', {
        code: 'POI-EXO',
        title: 'Exodoncia',
        body: BODY,
      })
      .expect(201);
    const templateId = (template.body as { id: string }).id;

    const patient = await as(clinicA)
      .post('/patients', {
        docType: 'CC',
        docNumber: DOC_NUMBER,
        sex: 'F',
        firstName: 'Mariana',
        lastName: LAST_NAME,
        email: EMAIL,
        birthDate: '1988-03-14',
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;

    const start = new Date(Date.now() + 10 * 60 * 1000);
    const appointment = await as(clinicA)
      .post('/appointments', {
        patientId,
        providerId: dentist.userId,
        start: start.toISOString(),
        end: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
      })
      .expect(201);
    const appointmentId = (appointment.body as { id: string }).id;

    const created = await as(clinicA)
      .post(`/appointments/${appointmentId}/post-op-instructions/deliveries`, {
        templateId,
        channel: 'EMAIL',
      })
      .expect(201);
    deliveryId = (created.body as { delivery: { id: string } }).delivery.id;
    // El token solo viaja en el email: se saca de ahí, como el paciente.
    const match = await mailer.waitFor(
      EMAIL,
      /\/indicaciones\/([A-Za-z0-9_-]{43})/,
    );
    token = match[1];
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('GET con el host de la clínica → 200 con el texto y la marca, sin datos del paciente', async () => {
    const res = await publicGet(clinicA.host, token).expect(200);
    const view = res.body as PublicPostOp;
    const row = await deliveryRow();
    const tenant = await raw.tenant.findUniqueOrThrow({
      where: { id: clinicA.tenantId },
    });
    expect(view).toEqual({
      clinic: {
        name: 'Clinica dx222-publica-a',
        logoUrl: tenant.logoUrl,
        primaryColor: tenant.primaryColor,
      },
      locationPhone: '601 555 0101',
      title: 'Exodoncia',
      code: 'POI-EXO',
      version: 1,
      renderedText: row.renderedText,
      deliveredAt: row.deliveredAt.toISOString(),
    });
    expect(view.renderedText).toContain('Muerde la gasa');
    expect(res.text).not.toContain(patientId);
    expect(res.text).not.toContain(LAST_NAME);
    expect(res.text).not.toContain(DOC_NUMBER);
    // Abrir la página no la marca como leída: eso lo hace el POST.
    expect((await deliveryRow()).firstOpenedAt).toBeNull();
  });

  it('el token de A en el host de B → 404, igual que uno inventado', async () => {
    const res = await publicGet(clinicB.host, token).expect(404);
    expect((res.body as { message: string }).message).toBe(
      POSTOP_LINK_NOT_FOUND_MESSAGE,
    );
    await publicOpened(clinicB.host, token).expect(404);
    expect((await deliveryRow()).firstOpenedAt).toBeNull();
  });

  it('token malformado → 404', async () => {
    const res = await publicGet(clinicA.host, 'no-es-un-token').expect(404);
    expect((res.body as { message: string }).message).toBe(
      POSTOP_LINK_NOT_FOUND_MESSAGE,
    );
    await publicOpened(clinicA.host, 'no-es-un-token').expect(404);
  });

  it('POST opened → 204 y la primera apertura se ve en la ficha; la segunda no cambia la fecha', async () => {
    const first = await publicOpened(clinicA.host, token).expect(204);
    expect(first.text).toBe('');
    const list = await as(clinicA)
      .get(`/patients/${patientId}/post-op-deliveries`)
      .expect(200);
    const summary = (
      list.body as Array<{ id: string; firstOpenedAt: string | null }>
    ).find((d) => d.id === deliveryId);
    expect(summary?.firstOpenedAt).not.toBeNull();
    const openedAt = (await deliveryRow()).firstOpenedAt;
    expect(openedAt?.toISOString()).toBe(summary?.firstOpenedAt);

    await publicOpened(clinicA.host, token).expect(204);
    expect((await deliveryRow()).firstOpenedAt).toEqual(openedAt);
  });

  it('a los 31 días el enlace caduca: GET y POST → 410 sin tocar la entrega', async () => {
    const before = await deliveryRow();
    offsetMs = 31 * DAY_MS;
    try {
      const res = await publicGet(clinicA.host, token).expect(410);
      expect((res.body as { message: string }).message).toBe(
        POSTOP_LINK_EXPIRED_MESSAGE,
      );
      const opened = await publicOpened(clinicA.host, token).expect(410);
      expect((opened.body as { message: string }).message).toBe(
        POSTOP_LINK_EXPIRED_MESSAGE,
      );
      expect(await deliveryRow()).toEqual(before);
    } finally {
      offsetMs = 0;
    }
  });
});
