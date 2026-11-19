import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { CatalogKind, Prisma, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { SEEDED_PASSWORD, resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  registerBody,
} from './support/location-fixtures';
import { seedParProviderRates } from './support/par-provider-rates';
import { createAppValidationPipe } from '../src/shared/validation/app-validation-pipe';
import {
  PORTAL_PLAN_KEYS,
  PORTAL_RESPONSE_KEYS,
  keysOutside,
} from './support/patient-portal-keys';

// DX-101 de punta a punta: el personal crea el enlace de acceso del paciente,
// el paciente lo abre con su fecha de nacimiento (cookie propia), ve SOLO lo
// compartido y SOLO lo suyo (con los mismos importes que el personal), puede
// confirmar una cita por el flujo de DX-005, y revocar corta la sesión abierta.
// Fuerza bruta: 429 al quinto fallo. Aislamiento: un token o una cookie de la
// clínica A en el host de B no sirven.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const BIRTH_DATE = '1988-03-14';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const COOKIE = 'dentalix_pa';

interface Session {
  tenantId: string;
  userId: string;
  accessToken: string;
  subdomain: string;
}

interface CreatedLink {
  id: string;
  url: string;
  expiresAt: string;
  scopes: string[];
  whatsapp: {
    phone: string;
    text: string;
    recipient: { kind: string; name: string | null };
  } | null;
  minor: boolean;
}

let dropParRates: (() => Promise<void>) | undefined;

describe('Enlace de acceso del paciente (DX-101, e2e)', () => {
  let app: INestApplication<App>;
  let clinicA: Session;
  let clinicB: Session;
  let patientA: string;
  let patientOther: string;
  let patientB: string;
  let catalogItemId: string;
  let billedPlan: string;
  let presentedPlan: string;
  let appointmentId: string;
  let otherAppointmentId: string;

  const server = () => app.getHttpServer();

  function as(session: Session, token = session.accessToken) {
    const host = hostFor(session.subdomain);
    return {
      get: (path: string) =>
        request(server())
          .get(`/api/v1${path}`)
          .set('X-Tenant-Host', host)
          .set('Authorization', `Bearer ${token}`),
      post: (path: string, body: object = {}) =>
        request(server())
          .post(`/api/v1${path}`)
          .set('X-Tenant-Host', host)
          .set('Authorization', `Bearer ${token}`)
          .send(body),
      patch: (path: string, body: object) =>
        request(server())
          .patch(`/api/v1${path}`)
          .set('X-Tenant-Host', host)
          .set('Authorization', `Bearer ${token}`)
          .send(body),
      delete: (path: string) =>
        request(server())
          .delete(`/api/v1${path}`)
          .set('X-Tenant-Host', host)
          .set('Authorization', `Bearer ${token}`),
    };
  }

  /** Las rutas públicas del portal, con el host (y la cookie) dados. */
  function portal(session: Session, cookie?: string) {
    const host = hostFor(session.subdomain);
    const withCookie = (r: request.Test) =>
      cookie ? r.set('Cookie', cookie) : r;
    return {
      verify: (token: string, birthDate: unknown) =>
        request(server())
          .post(`/api/v1/public/patient-access/${token}/verify`)
          .set('X-Tenant-Host', host)
          .send({ birthDate }),
      me: () =>
        withCookie(
          request(server())
            .get('/api/v1/public/patient-access/me')
            .set('X-Tenant-Host', host),
        ),
      confirm: (id: string) =>
        withCookie(
          request(server())
            .post(`/api/v1/public/patient-access/me/appointments/${id}/confirm`)
            .set('X-Tenant-Host', host),
        ),
      logout: () =>
        withCookie(
          request(server())
            .post('/api/v1/public/patient-access/me/logout')
            .set('X-Tenant-Host', host),
        ),
    };
  }

  const tokenOf = (link: CreatedLink) => link.url.split('/mi-clinica/')[1];

  function sessionCookie(res: request.Response): string {
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const mine = cookies.find((c) => c.startsWith(`${COOKIE}=`));
    if (!mine) throw new Error('sin cookie del portal');
    return mine.split(';')[0];
  }

  async function register(subdomain: string): Promise<Session> {
    const email = `owner@${subdomain}.com`;
    const reg = await registerVerified(
      app,
      registerBody(REGIONAL_CARACAS_FIXTURE, {
        clinicName: `Clinica ${subdomain}`,
        subdomain,
        email,
        password: SEEDED_PASSWORD,
        fullName: 'Dra. Owner',
      }),
    );
    const login = await request(server())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(subdomain))
      .send({ email, password: SEEDED_PASSWORD })
      .expect(201);
    return {
      tenantId: (reg.body as { tenantId: string }).tenantId,
      userId: (reg.body as { userId: string }).userId,
      accessToken: (login.body as { accessToken: string }).accessToken,
      subdomain,
    };
  }

  async function createPatient(
    session: Session,
    docNumber: string,
    extra: object = {},
  ): Promise<string> {
    const res = await as(session)
      .post('/patients', {
        firstName: 'Carmen Elena',
        lastName: 'Rondón',
        docType: 'NATIONAL_ID',
        docNumber,
        sex: Sex.F,
        birthDate: BIRTH_DATE,
        phone: '+58 412 555 0101',
        ...extra,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function createLink(
    session: Session,
    patientId: string,
    body: object = { scopes: ['APPOINTMENTS', 'PLANS', 'ACCOUNT'] },
  ): Promise<CreatedLink> {
    const res = await as(session)
      .post(`/patients/${patientId}/access-links`, body)
      .expect(201);
    return res.body as CreatedLink;
  }

  async function openPortal(
    session: Session,
    link: CreatedLink,
  ): Promise<string> {
    const res = await portal(session)
      .verify(tokenOf(link), BIRTH_DATE)
      .expect(200);
    return sessionCookie(res);
  }

  async function appointment(
    session: Session,
    patientId: string,
    daysAhead: number,
  ): Promise<string> {
    const location = await raw.location.findFirstOrThrow({
      where: { tenantId: session.tenantId },
    });
    const start = new Date(Date.now() + daysAhead * 86_400_000);
    const row = await raw.appointment.create({
      data: {
        tenantId: session.tenantId,
        locationId: location.id,
        patientId,
        providerId: session.userId,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
        status: 'SCHEDULED',
      },
      select: { id: true },
    });
    return row.id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    await app.listen(0, '127.0.0.1');
    await resetDatabase(raw);
    dropParRates = await seedParProviderRates(raw);

    clinicA = await register('dx101-acceso-a');
    clinicB = await register('dx101-acceso-b');
    patientA = await createPatient(clinicA, 'V-12345678');
    patientOther = await createPatient(clinicA, 'V-87654321', {
      firstName: 'Pedro',
      lastName: 'Ajeno',
    });
    patientB = await createPatient(clinicB, 'V-11111111');

    const catalog = await as(clinicA)
      .post('/catalog/items', {
        code: 'DX101-RES',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Resina',
        color: '#2A2B3C',
        defaultPrice: 1,
      })
      .expect(201);
    catalogItemId = (catalog.body as { id: string }).id;

    // Plan cobrable (ítem aceptado) con un abono de dos decimales (DX-098).
    const billed = await as(clinicA)
      .post(`/patients/${patientA}/treatment-plans`, { currency: 'USD' })
      .expect(201);
    billedPlan = (billed.body as { id: string }).id;
    const item = await as(clinicA)
      .post(`/treatment-plans/${billedPlan}/items`, {
        toothNumber: '16',
        catalogItemId,
        price: 250.5,
      })
      .expect(201);
    await as(clinicA)
      .patch(
        `/treatment-plans/${billedPlan}/items/${(item.body as { id: string }).id}`,
        { status: 'ACCEPTED' },
      )
      .expect(200);
    await as(clinicA)
      .post(`/treatment-plans/${billedPlan}/payments`, {
        amount: 100.15,
        currency: 'USD',
        paidAt: '2026-07-01',
        method: 'CASH',
      })
      .expect(201);

    // Presupuesto presentado (sale en «Presupuestos»).
    const presented = await as(clinicA)
      .post(`/patients/${patientA}/treatment-plans`, { currency: 'USD' })
      .expect(201);
    presentedPlan = (presented.body as { id: string }).id;
    await as(clinicA)
      .post(`/treatment-plans/${presentedPlan}/items`, {
        toothNumber: '21',
        catalogItemId,
        price: 80.25,
      })
      .expect(201);
    await as(clinicA)
      .post(`/treatment-plans/${presentedPlan}/present`, {})
      .expect(200);

    appointmentId = await appointment(clinicA, patientA, 7);
    otherAppointmentId = await appointment(clinicA, patientOther, 8);
  });

  afterAll(async () => {
    await dropParRates?.();
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('ciclo: crear → verificar → ver → revocar; la sesión abierta cae al revocar', async () => {
    const link = await createLink(clinicA, patientA);
    expect(link.scopes).toEqual(['APPOINTMENTS', 'PLANS', 'ACCOUNT']);
    expect(link.url).toMatch(
      /^https?:\/\/dx101-acceso-a\.[^/]+\/mi-clinica\/[A-Za-z0-9_-]{43}$/,
    );
    expect(link.whatsapp?.phone).toBe('584125550101');
    expect(link.whatsapp?.text).toContain(link.url);
    expect(link.minor).toBe(false);
    // Solo el hash en la BD.
    const row = await raw.patientAccessLink.findUniqueOrThrow({
      where: { id: link.id },
    });
    expect(row.tokenHash).not.toContain(tokenOf(link));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // La lista no trae la URL ni el token.
    const list = await as(clinicA)
      .get(`/patients/${patientA}/access-links`)
      .expect(200);
    expect(JSON.stringify(list.body)).not.toContain(tokenOf(link));
    expect(list.body).toEqual([
      expect.objectContaining({
        id: link.id,
        lastViewedAt: null,
        lockedUntil: null,
        createdBy: { id: clinicA.userId, fullName: 'Dra. Owner' },
      }),
    ]);

    // Fecha errónea: «Datos incorrectos».
    const wrong = await portal(clinicA)
      .verify(tokenOf(link), '1988-03-15')
      .expect(400);
    expect(wrong.body).toMatchObject({
      code: 'PATIENT_ACCESS_INVALID',
      message: 'Datos incorrectos',
    });

    // Fecha correcta: la cookie propia, sin nada de la sesión en el body.
    const ok = await portal(clinicA)
      .verify(tokenOf(link), BIRTH_DATE)
      .expect(200);
    const setCookie = ([] as string[])
      .concat(ok.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith(`${COOKIE}=`))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api\/v1\/public\/patient-access/);
    expect(Object.keys(ok.body as object).sort()).toEqual([
      'scopes',
      'sessionExpiresAt',
    ]);
    const cookie = sessionCookie(ok);

    const me = await portal(clinicA, cookie).me().expect(200);
    expect(me.headers['cache-control']).toBe('no-store');
    expect(me.headers['referrer-policy']).toBe('no-referrer');
    expect(me.headers['x-robots-tag']).toBe('noindex, nofollow');
    const body = me.body as {
      patientFirstName: string;
      clinicName: string;
      appointments: { id: string; confirmable: boolean }[];
      plans: {
        id: string;
        status: string;
        quote: { items: { procedure: string; unitPrice: number }[] };
      }[];
      account: {
        summary: unknown;
        installments: unknown;
        plans: unknown;
        movements: {
          amount: number;
        }[];
      };
    };
    expect(body.patientFirstName).toBe('Carmen');
    expect(body.appointments.map((a) => a.id)).toEqual([appointmentId]);
    expect(body.appointments[0].confirmable).toBe(true);
    expect(body.plans.map((p) => [p.id, p.status])).toEqual([
      [presentedPlan, 'PRESENTED'],
    ]);
    expect(body.plans[0].quote.items).toEqual([
      expect.objectContaining({ procedure: 'Resina', unitPrice: 80.25 }),
    ]);
    // Lista blanca: ninguna clave fuera de lo decidido para el paciente.
    expect(keysOutside(me.body, PORTAL_RESPONSE_KEYS)).toEqual([]);
    // Nada del otro paciente de la clínica.
    expect(JSON.stringify(body)).not.toContain(patientOther);
    expect(JSON.stringify(body)).not.toContain(otherAppointmentId);

    // Los importes del paciente = los del personal, al céntimo.
    const staff = await as(clinicA)
      .get(`/patients/${patientA}/account-statement`)
      .expect(200);
    const staffBody = staff.body as typeof body.account;
    expect(body.account.summary).toEqual(staffBody.summary);
    expect(body.account.installments).toEqual(staffBody.installments);
    expect(body.account.plans).toEqual(
      (staffBody.plans as { paymentsWithoutRate?: unknown }[]).map(
        ({ paymentsWithoutRate: _omit, ...rest }) => rest,
      ),
    );
    expect(body.account.movements.map((m) => m.amount)).toEqual([100.15]);
    // Sin autores, ids internos ni «se puede anular».
    expect(JSON.stringify(body.account.movements)).not.toMatch(
      /createdById|canVoid|voidedBy|voidReason|splitId/,
    );

    // Último acceso visible para el personal.
    const after = await as(clinicA)
      .get(`/patients/${patientA}/access-links`)
      .expect(200);
    expect(
      (after.body as { lastViewedAt: string | null }[])[0].lastViewedAt,
    ).not.toBeNull();

    // Revocar corta la sesión abierta en la siguiente petición: 410 sin datos.
    await as(clinicA)
      .delete(`/patients/${patientA}/access-links/${link.id}`)
      .expect(204);
    const gone = await portal(clinicA, cookie).me().expect(410);
    expect(gone.body).toMatchObject({ code: 'PATIENT_ACCESS_GONE' });
    expect(JSON.stringify(gone.body)).not.toMatch(/Carmen|Rondón|100\.15/);
    expect(gone.headers['cache-control']).toBe('no-store');
    // Revocado: la verificación responde igual que un token inventado.
    const again = await portal(clinicA)
      .verify(tokenOf(link), BIRTH_DATE)
      .expect(400);
    expect(again.body).toMatchObject({ message: 'Datos incorrectos' });
    // Idempotente y fuera de la lista.
    await as(clinicA)
      .delete(`/patients/${patientA}/access-links/${link.id}`)
      .expect(204);
    const empty = await as(clinicA)
      .get(`/patients/${patientA}/access-links`)
      .expect(200);
    expect(empty.body).toEqual([]);

    // Auditado: alta, acceso verificado (con los fallos previos agregados) y
    // revocación; nunca la fecha ni el token.
    const events = await raw.auditEvent.findMany({
      where: { resourceType: 'PATIENT_ACCESS_LINK', resourceId: link.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(
      events.map((e) => [e.action, (e.metadata as { reason?: string }).reason]),
    ).toEqual([
      ['CREATE', 'PATIENT_ACCESS_LINK_CREATED'],
      ['VIEW', 'PATIENT_ACCESS_VERIFIED'],
      ['DELETE', 'PATIENT_ACCESS_LINK_REVOKED'],
    ]);
    const verified = events[1];
    expect(verified).toMatchObject({
      actorUserId: null,
      actorRole: null,
      patientId: patientA,
    });
    expect(verified.metadata).toMatchObject({
      origin: 'PUBLIC_LINK',
      failedAttempts: 1,
    });
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(BIRTH_DATE);
    expect(dump).not.toContain('1988-03-15');
    expect(dump).not.toContain(tokenOf(link));
  });

  it('solo los apartados compartidos: los demás llegan null', async () => {
    const link = await createLink(clinicA, patientA, {
      scopes: ['ACCOUNT'],
      ttlDays: 3,
    });
    const cookie = await openPortal(clinicA, link);
    const me = await portal(clinicA, cookie).me().expect(200);
    expect(me.body).toMatchObject({
      scopes: ['ACCOUNT'],
      appointments: null,
      plans: null,
    });
    expect((me.body as { account: unknown }).account).not.toBeNull();
    // Sin el apartado de citas, tampoco confirma.
    await portal(clinicA, cookie).confirm(appointmentId).expect(404);
  });

  it('confirmar una cita por el flujo de DX-005; la de otro paciente es 404', async () => {
    const link = await createLink(clinicA, patientA, {
      scopes: ['APPOINTMENTS'],
    });
    const cookie = await openPortal(clinicA, link);
    await portal(clinicA, cookie).confirm(otherAppointmentId).expect(404);
    const res = await portal(clinicA, cookie)
      .confirm(appointmentId)
      .expect(200);
    expect(res.body).toEqual({ status: 'CONFIRMED' });
    const appt = await raw.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
    });
    expect(appt.status).toBe('CONFIRMED');
    const other = await raw.appointment.findUniqueOrThrow({
      where: { id: otherAppointmentId },
    });
    expect(other.status).toBe('SCHEDULED');
    const confirmed = await raw.auditEvent.findFirst({
      where: { resourceType: 'APPOINTMENT', resourceId: appointmentId },
      orderBy: { occurredAt: 'desc' },
    });
    expect(confirmed?.metadata).toMatchObject({
      reason: 'CONFIRMATION_LINK_CONFIRMED',
    });
    // Ya confirmada: deja de ser confirmable.
    const me = await portal(clinicA, cookie).me().expect(200);
    expect(
      (me.body as { appointments: { confirmable: boolean }[] }).appointments,
    ).toEqual([expect.objectContaining({ confirmable: false })]);
    await portal(clinicA, cookie).confirm(appointmentId).expect(404);
  });

  it('fuerza bruta: 4 × «Datos incorrectos» y al quinto 429 en español; bloqueado aunque acierte', async () => {
    const link = await createLink(clinicA, patientA);
    for (let i = 0; i < 4; i++) {
      await portal(clinicA).verify(tokenOf(link), '2000-01-01').expect(400);
    }
    const fifth = await portal(clinicA)
      .verify(tokenOf(link), '2000-01-01')
      .expect(429);
    expect(fifth.body).toMatchObject({
      code: 'PATIENT_ACCESS_LOCKED',
      message:
        'Demasiados intentos. Por seguridad, el enlace queda bloqueado 30 minutos.',
    });
    expect(
      typeof (fifth.body as { retryAfterSeconds: unknown }).retryAfterSeconds,
    ).toBe('number');
    await portal(clinicA).verify(tokenOf(link), BIRTH_DATE).expect(429);
    const row = await raw.patientAccessLink.findUniqueOrThrow({
      where: { id: link.id },
    });
    expect(row.failedAttempts).toBe(5);
    expect(row.lockedUntil).not.toBeNull();
    // El personal lo ve bloqueado.
    const list = await as(clinicA)
      .get(`/patients/${patientA}/access-links`)
      .expect(200);
    const mine = (
      list.body as { id: string; lockedUntil: string | null }[]
    ).find((l) => l.id === link.id);
    expect(mine?.lockedUntil).not.toBeNull();
    // Auditado una vez, agregado (5 fallos), sin la fecha.
    const locked = await raw.auditEvent.findMany({
      where: {
        resourceType: 'PATIENT_ACCESS_LINK',
        resourceId: link.id,
        action: 'UPDATE',
      },
    });
    expect(locked).toHaveLength(1);
    expect(locked[0].metadata).toMatchObject({
      reason: 'PATIENT_ACCESS_LOCKED',
      failedAttempts: 5,
    });
    // Un token inventado sigue exactamente el mismo camino (no revela nada).
    const fake = 'Z'.repeat(43);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await portal(clinicA).verify(fake, '2000-01-01')).status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 429]);
  });

  // ISOLATION_COVERS: POST /public/patient-access/:token/verify
  it('aislamiento: el token o la cookie de A en el host de B no sirven', async () => {
    const link = await createLink(clinicA, patientA, {
      scopes: ['APPOINTMENTS', 'ACCOUNT'],
    });
    // El token de A con la fecha CORRECTA en el host de B: igual que uno
    // inventado.
    const cross = await portal(clinicB)
      .verify(tokenOf(link), BIRTH_DATE)
      .expect(400);
    expect(cross.body).toMatchObject({ message: 'Datos incorrectos' });
    expect(cross.headers['set-cookie']).toBeUndefined();
    // La cookie de A en el host de B: 401, sin datos ni confirmación.
    const cookie = await openPortal(clinicA, link);
    const me = await portal(clinicB, cookie).me().expect(401);
    expect(JSON.stringify(me.body)).not.toContain('Carmen');
    const fresh = await appointment(clinicA, patientA, 9);
    await portal(clinicB, cookie).confirm(fresh).expect(401);
    expect(
      (await raw.appointment.findUniqueOrThrow({ where: { id: fresh } }))
        .status,
    ).toBe('SCHEDULED');
    // En su host sigue sirviendo.
    await portal(clinicA, cookie).me().expect(200);
  });

  // ISOLATION_COVERS: POST /patients/:id/access-links
  // ISOLATION_COVERS: GET /patients/:id/access-links
  // ISOLATION_COVERS: DELETE /patients/:id/access-links/:linkId
  it('aislamiento del personal: B → 404 sobre el paciente y el enlace de A', async () => {
    const link = await createLink(clinicA, patientA);
    await as(clinicB)
      .post(`/patients/${patientA}/access-links`, { scopes: ['ACCOUNT'] })
      .expect(404);
    await as(clinicB).get(`/patients/${patientA}/access-links`).expect(404);
    await as(clinicB)
      .delete(`/patients/${patientA}/access-links/${link.id}`)
      .expect(404);
    // Con un paciente propio de B y el enlace de A, tampoco.
    await as(clinicB)
      .delete(`/patients/${patientB}/access-links/${link.id}`)
      .expect(404);
    // El de A sigue vivo.
    const cookie = await openPortal(clinicA, link);
    await portal(clinicA, cookie).me().expect(200);
  });

  it('la sesión del portal no abre rutas del personal, ni el token del personal abre el portal', async () => {
    const link = await createLink(clinicA, patientA);
    const cookie = await openPortal(clinicA, link);
    // Solo la cookie del portal: 401 en el personal.
    await request(server())
      .get(`/api/v1/patients/${patientA}/account-statement`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Cookie', cookie)
      .expect(401);
    await request(server())
      .get(`/api/v1/patients/${patientA}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Cookie', cookie)
      .expect(401);
    // Solo el Bearer del personal: 401 en el portal.
    await request(server())
      .get('/api/v1/public/patient-access/me')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(401);
    // Salir borra la cookie.
    const out = await portal(clinicA, cookie).logout().expect(204);
    expect(
      ([] as string[])
        .concat(out.headers['set-cookie'] ?? [])
        .some((c) => c.startsWith(`${COOKIE}=;`)),
    ).toBe(true);
  });

  it('crear: 409 sin fecha de nacimiento; 400 sin apartados o validez fuera de rango; menor marcado', async () => {
    const noBirth = await createPatient(clinicA, 'V-22222222', {
      birthDate: undefined,
    });
    const res = await as(clinicA)
      .post(`/patients/${noBirth}/access-links`, { scopes: ['ACCOUNT'] })
      .expect(409);
    expect(res.body).toMatchObject({ code: 'PATIENT_ACCESS_NO_BIRTH_DATE' });
    for (const body of [
      { scopes: [] },
      { scopes: ['ACCOUNT', 'ACCOUNT'] },
      { scopes: ['CLINICAL'] },
      { scopes: ['ACCOUNT'], ttlDays: 0 },
      { scopes: ['ACCOUNT'], ttlDays: 31 },
    ]) {
      await as(clinicA)
        .post(`/patients/${patientA}/access-links`, body)
        .expect(400);
    }
    const minor = await createPatient(clinicA, 'V-33333333', {
      birthDate: '2016-06-01',
    });
    const link = await createLink(clinicA, minor, { scopes: ['PLANS'] });
    expect(link.minor).toBe(true);
    // Sin responsable: al teléfono del paciente.
    expect(link.whatsapp).toMatchObject({
      phone: '584125550101',
      recipient: { kind: 'PATIENT', name: null },
    });
    // Con su madre como responsable con teléfono (DX-342): a ella.
    await raw.patientResponsibleParty.create({
      data: {
        tenantId: clinicA.tenantId,
        patientId: minor,
        fullName: 'Ana Rondón',
        phone: '+58 414 555 0202',
        relationship: 'MOTHER',
        isPayer: true,
      },
    });
    const toMother = await createLink(clinicA, minor, { scopes: ['PLANS'] });
    expect(toMother.whatsapp).toMatchObject({
      phone: '584145550202',
      recipient: { kind: 'RESPONSIBLE', name: 'Ana Rondón' },
    });
    expect(toMother.whatsapp?.text).toContain('Hola Ana');
  });

  it('un presupuesto aceptado: de la aceptación solo quién firmó, la firma y cuándo (ni IP, ni navegador, ni quién registró)', async () => {
    const quote = await as(clinicA)
      .get(`/patients/${patientA}/treatment-plans/${presentedPlan}/quote`)
      .expect(200);
    await request(server())
      .post(
        `/api/v1/patients/${patientA}/treatment-plans/${presentedPlan}/acceptance`,
      )
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .set('User-Agent', 'NavegadorDelPersonal/9.9')
      .send({
        signerName: 'Carmen Rondón',
        signature: `data:image/png;base64,${PNG}`,
        contentHash: (quote.body as { contentHash: string }).contentHash,
      })
      .expect(201);
    const link = await createLink(clinicA, patientA, { scopes: ['PLANS'] });
    const cookie = await openPortal(clinicA, link);
    const me = await portal(clinicA, cookie).me().expect(200);
    expect(keysOutside(me.body, PORTAL_RESPONSE_KEYS)).toEqual([]);
    const plan = (
      me.body as {
        plans: { id: string; status: string; quote: { acceptance: unknown } }[];
      }
    ).plans.find((p) => p.id === presentedPlan);
    expect(plan?.status).toBe('ACCEPTED');
    expect(Object.keys(plan!.quote.acceptance as object).sort()).toEqual([
      'acceptedAt',
      'signature',
      'signerName',
    ]);
    const json = JSON.stringify(me.body);
    expect(json).not.toContain('NavegadorDelPersonal');
    expect(json).not.toMatch(
      /ipAddress|userAgent|acceptedByName|acceptanceHash/,
    );
  });

  it('DX-101-bis: verificar → ver → aceptar con la cookie; la respuesta es la lista blanca de un plan y el personal lo ve «desde el portal»', async () => {
    const created = await as(clinicA)
      .post(`/patients/${patientA}/treatment-plans`, { currency: 'USD' })
      .expect(201);
    const planId = (created.body as { id: string }).id;
    await as(clinicA)
      .post(`/treatment-plans/${planId}/items`, {
        toothNumber: '11',
        catalogItemId,
        price: 120.5,
      })
      .expect(201);
    await as(clinicA).post(`/treatment-plans/${planId}/present`).expect(200);

    const link = await createLink(clinicA, patientA, { scopes: ['PLANS'] });
    const cookie = await openPortal(clinicA, link);
    const before = await portal(clinicA, cookie).me().expect(200);
    expect(keysOutside(before.body, PORTAL_RESPONSE_KEYS)).toEqual([]);
    const shown = (
      before.body as {
        plans: {
          id: string;
          acceptable: boolean;
          contentHash: string;
          validUntil: string;
          acceptedAt: string | null;
        }[];
      }
    ).plans.find((p) => p.id === planId)!;
    expect(shown).toMatchObject({ acceptable: true, acceptedAt: null });
    expect(shown.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const path = `/api/v1/public/patient-access/me/plans/${planId}/accept`;
    const body = {
      signerName: 'Carmen Rondón',
      signature: `data:image/png;base64,${PNG}`,
      contentHash: shown.contentHash,
      consent: true,
    };
    // Sin cookie: 401; sin `consent: true`: 400.
    await request(server())
      .post(path)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .send(body)
      .expect(401);
    await request(server())
      .post(path)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Cookie', cookie)
      .send({ ...body, consent: false })
      .expect(400);
    // Nombre con caracteres de control o de dirección (bidi): 400.
    for (const signerName of ['Carmen\u202ERondón', 'Carmen\nRondón']) {
      const bad = await request(server())
        .post(path)
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Cookie', cookie)
        .send({ ...body, signerName })
        .expect(400);
      expect(JSON.stringify(bad.body)).toContain(
        'Escribe tu nombre sin caracteres especiales.',
      );
    }

    const res = await request(server())
      .post(path)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Cookie', cookie)
      .set('User-Agent', 'NavegadorDelPaciente/1.0')
      .send(body)
      .expect(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(keysOutside(res.body, PORTAL_PLAN_KEYS)).toEqual([]);
    expect(res.body).toMatchObject({
      id: planId,
      status: 'ACCEPTED',
      acceptable: false,
      contentHash: shown.contentHash,
      quote: { acceptance: { signerName: 'Carmen Rondón' } },
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /NavegadorDelPaciente|ipAddress|patientAccessLinkId|acceptedByName/,
    );

    // El personal: aceptado desde el portal, con el evento del paciente.
    const detail = await as(clinicA)
      .get(`/treatment-plans/${planId}`)
      .expect(200);
    expect(
      (detail.body as { acceptance: { portal: unknown } }).acceptance.portal,
    ).not.toBeNull();
    const events = await raw.auditEvent.findMany({
      where: { resourceType: 'TREATMENT_PLAN', resourceId: planId },
      select: { action: true, actorUserId: true, metadata: true },
    });
    expect(events).toContainEqual({
      action: 'SIGN',
      actorUserId: null,
      metadata: { origin: 'PUBLIC_LINK', reason: 'PORTAL_QUOTE_ACCEPTED' },
    });

    // Otra vez: el 409 genérico.
    const again = await request(server())
      .post(path)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Cookie', cookie)
      .send(body)
      .expect(409);
    expect(again.body).toMatchObject({ code: 'PORTAL_QUOTE_NOT_ACCEPTABLE' });
  });

  it('archivar al paciente revoca sus enlaces: la sesión abierta da 410', async () => {
    const patient = await createPatient(clinicA, 'V-44444444');
    const link = await createLink(clinicA, patient, { scopes: ['ACCOUNT'] });
    const cookie = await openPortal(clinicA, link);
    const counts = await as(clinicA)
      .get(`/patients/${patient}/live-public-links`)
      .expect(200);
    expect(counts.body).toMatchObject({ patientAccessLinks: 1 });
    await as(clinicA).delete(`/patients/${patient}`).expect(204);
    await portal(clinicA, cookie).me().expect(410);
    const row = await raw.patientAccessLink.findUniqueOrThrow({
      where: { id: link.id },
    });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedById).toBe(clinicA.userId);
  });
});
