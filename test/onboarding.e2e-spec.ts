import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  type Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { ONBOARDING_FORBIDDEN_MESSAGE } from '../src/modules/onboarding/presentation/onboarding.controller';

// DX-020 en HTTP real: la tarjeta «Pon en marcha tu clínica». Solo ADMIN;
// cada paso se marca solo al hacer lo que pide, sin tocar la tarjeta; otra
// clínica no ve ni mueve nada; descartar es idempotente.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface StatusBody {
  dismissedAt: string | null;
  steps: { key: string; done: boolean; optional: boolean }[];
  completedCount: number;
  requiredCount: number;
  allDone: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = new Date(Date.now() + 5 * DAY_MS).toISOString().slice(0, 10);

describe('Puesta en marcha de la clínica (e2e, DX-020)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;

  const server = () => app.getHttpServer();
  const as = (clinic: Clinic, token = clinic.adminToken) => ({
    get: (path: string) =>
      request(server())
        .get(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      request(server())
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    put: (path: string, body: object) =>
      request(server())
        .put(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    patch: (path: string, body: object) =>
      request(server())
        .patch(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });

  async function status(clinic: Clinic): Promise<StatusBody> {
    return (await as(clinic).get('/onboarding/status').expect(200))
      .body as StatusBody;
  }
  const done = (body: StatusBody) =>
    Object.fromEntries(body.steps.map((s) => [s.key, s.done]));

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    a = await registerClinic(app, 'dx020-clinica-a');
    b = await registerClinic(app, 'dx020-clinica-b');
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('una clínica recién creada: los 5 pasos pendientes y la tarjeta visible', async () => {
    const body = await status(a);
    expect(body).toEqual({
      dismissedAt: null,
      steps: [
        { key: 'BUSINESS_HOURS', done: false, optional: false },
        { key: 'APPOINTMENT_TYPES', done: false, optional: false },
        { key: 'CATALOG_PRICES', done: false, optional: false },
        { key: 'STAFF', done: false, optional: false },
        { key: 'FIRST_APPOINTMENT', done: false, optional: false },
        { key: 'PATIENT_IMPORT', done: false, optional: true },
      ],
      completedCount: 0,
      requiredCount: 5,
      allDone: false,
    });
  });

  it('cada paso se marca solo al hacer lo que pide, y solo en su clínica', async () => {
    // 1. Horario: guardar la semana (aunque sea la misma) cuenta; el sembrado no.
    const current = (await as(a).get('/locations/schedule').expect(200))
      .body as { ranges: object[] };
    await as(a)
      .put('/locations/schedule', { ranges: current.ranges })
      .expect(200);
    expect(done(await status(a)).BUSINESS_HOURS).toBe(true);

    // 2. Tipo de cita.
    await as(a)
      .post('/appointment-types', {
        name: 'Limpieza',
        durationMinutes: 30,
        color: '#0E7490',
      })
      .expect(201);
    expect(done(await status(a)).APPOINTMENT_TYPES).toBe(true);

    // 3. Precio: la semilla nace sin precios; poner uno a un procedimiento.
    const item = await raw.dentalCatalogItem.findFirstOrThrow({
      where: { tenantId: a.tenantId, kind: 'PROCEDURE', deletedAt: null },
      select: { id: true },
    });
    await as(a)
      .patch(`/catalog/items/${item.id}`, { defaultPrice: 40 })
      .expect(200);
    expect(done(await status(a)).CATALOG_PRICES).toBe(true);

    // 4. Personal: una invitación basta.
    await as(a)
      .post('/staff/invitations', {
        fullName: 'Persona Invitada',
        email: 'invitada@dx020-clinica-a.test',
        role: ClinicRole.DENTIST,
      })
      .expect(201);
    expect(done(await status(a)).STAFF).toBe(true);

    // 5. Primera cita (sede sin restricción de horario, para no depender del día).
    await as(a).put('/locations/schedule', { ranges: [] }).expect(200);
    const patient = (
      await as(a)
        .post('/patients', {
          firstName: 'Ana',
          lastName: 'Pérez',
          docType: 'NATIONAL_ID',
          docNumber: 'V-20020020',
          sex: 'F',
        })
        .expect(201)
    ).body as { id: string };
    await as(a)
      .post('/appointments', {
        patientId: patient.id,
        providerId: a.adminUserId,
        start: `${DAY}T14:00:00.000Z`,
        end: `${DAY}T14:30:00.000Z`,
      })
      .expect(201);

    const final = await status(a);
    expect(final.completedCount).toBe(5);
    expect(final.allDone).toBe(true);
    expect(done(final).PATIENT_IMPORT).toBe(false);

    // La otra clínica sigue como nació.
    const other = await status(b);
    expect(other.completedCount).toBe(0);
    expect(other.dismissedAt).toBeNull();
  });

  it('un miembro además del que creó la clínica también cuenta como personal', async () => {
    expect(done(await status(b)).STAFF).toBe(false);
    await seedMember(raw, b, ClinicRole.RECEPTION);
    expect(done(await status(b)).STAFF).toBe(true);
  });

  it('una invitación revocada no cuenta', async () => {
    const c = await registerClinic(app, 'dx020-clinica-c');
    const inv = (
      await as(c)
        .post('/staff/invitations', {
          fullName: 'Persona Revocada',
          email: 'revocada@dx020-clinica-c.test',
          role: ClinicRole.ASSISTANT,
        })
        .expect(201)
    ).body as { id: string };
    await raw.clinicInvitation.update({
      where: { id: inv.id },
      data: { revokedAt: new Date() },
    });
    expect(done(await status(c)).STAFF).toBe(false);
  });

  it.each([ClinicRole.DENTIST, ClinicRole.ASSISTANT, ClinicRole.RECEPTION])(
    '%s → 403 en las dos rutas, con el mensaje en español',
    async (role) => {
      const member = await seedMember(raw, a, role);
      const token = await loginAs(app, a.host, member.email);
      const get = await as(a, token).get('/onboarding/status').expect(403);
      expect((get.body as { message: string }).message).toBe(
        ONBOARDING_FORBIDDEN_MESSAGE,
      );
      await as(a, token).post('/onboarding/dismiss').expect(403);
      const tenant = await raw.tenant.findUniqueOrThrow({
        where: { id: a.tenantId },
        select: { onboardingDismissedAt: true },
      });
      expect(tenant.onboardingDismissedAt).toBeNull();
    },
  );

  it('el token de otra clínica no sirve en esta', async () => {
    await request(server())
      .get('/api/v1/onboarding/status')
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${b.adminToken}`)
      .expect((res) => expect([401, 403]).toContain(res.status));
  });

  it('descartar: solo su clínica, y un segundo descarte conserva la fecha', async () => {
    const first = (await as(a).post('/onboarding/dismiss').expect(200))
      .body as StatusBody;
    expect(first.dismissedAt).not.toBeNull();
    expect(first.allDone).toBe(true);
    expect((await status(a)).dismissedAt).toBe(first.dismissedAt);

    const again = (await as(a).post('/onboarding/dismiss').expect(200))
      .body as StatusBody;
    expect(again.dismissedAt).toBe(first.dismissedAt);

    expect((await status(b)).dismissedAt).toBeNull();
  });
});
