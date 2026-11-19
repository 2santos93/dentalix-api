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
import { ONLINE_BOOKING_CLOCK } from '../src/modules/online-booking/application/use-cases/public-booking.use-cases';

// DX-016 en HTTP real: la reserva online de punta a punta. La clínica sale
// SOLO del host (X-Tenant-Host); por defecto está desactivada. El reloj de la
// reserva va adelantado a mano para el tiempo mínimo de rellenado del
// formulario (4 s) sin esperar. DIRECT_URL (owner, sin RLS) siembra y mira.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const TZ_OFFSET = '-04:00'; // Caracas, sin horario de verano.

/** Un lunes a 10+ días vista (YYYY-MM-DD, en Caracas). */
function monthDay(): string {
  const d = new Date(Date.now() + 10 * DAY_MS);
  while (d.getUTCDay() !== 1) d.setTime(d.getTime() + DAY_MS);
  return d.toISOString().slice(0, 10);
}
const DAY = monthDay();
const local = (hhmm: string) => new Date(`${DAY}T${hhmm}:00${TZ_OFFSET}`);

interface Slot {
  start: string;
  end: string;
  providerId: string;
}

describe('Reserva online (e2e, DX-016)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let locationId: string;
  let typeId: string;
  let policyId: string;
  let receptionToken: string;
  let skewMs = 0;
  const mailer = new CapturingMailer();

  const server = () => request(app.getHttpServer());
  const pub = (host: string) => ({
    config: () =>
      server().get('/api/v1/public/booking').set('X-Tenant-Host', host),
    slots: (q: Record<string, string>, session?: string) => {
      const r = server()
        .get('/api/v1/public/booking/slots')
        .query(q)
        .set('X-Tenant-Host', host);
      return session ? r.set('X-Booking-Session', session) : r;
    },
    code: (body: object) =>
      server()
        .post('/api/v1/public/booking/verification')
        .set('X-Tenant-Host', host)
        .send(body),
    verify: (id: string, code: string) =>
      server()
        .post(`/api/v1/public/booking/verification/${id}/verify`)
        .set('X-Tenant-Host', host)
        .send({ code }),
    book: (body: object, session?: string) => {
      const r = server()
        .post('/api/v1/public/booking')
        .set('X-Tenant-Host', host);
      return (session ? r.set('X-Booking-Session', session) : r).send(body);
    },
  });
  const staff = (token: string, host = clinic.host) => ({
    get: (path: string) =>
      server()
        .get(`/api/v1${path}`)
        .set('X-Tenant-Host', host)
        .set('Authorization', `Bearer ${token}`),
    put: (path: string, body: object) =>
      server()
        .put(`/api/v1${path}`)
        .set('X-Tenant-Host', host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    post: (path: string) =>
      server()
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', host)
        .set('Authorization', `Bearer ${token}`)
        .send({}),
  });

  /** El `formToken` de la página, ya «rellenado» (reloj 5 s después). */
  async function formToken(host = clinic.host): Promise<string> {
    const res = await pub(host).config().expect(200);
    skewMs += 5000;
    return (res.body as { formToken: string }).formToken;
  }

  async function enable(over: object = {}): Promise<void> {
    await staff(clinic.adminToken)
      .put('/online-booking/settings', {
        enabled: true,
        newPatientMode: 'DIRECT',
        existingPatientMode: 'REQUEST',
        minLeadMinutesNew: 120,
        minLeadMinutesExisting: 60,
        maxAdvanceDays: 60,
        slotStepMinutes: 30,
        ...over,
      })
      .expect(200);
  }

  async function slotsOn(session?: string, kind = 'NEW'): Promise<Slot[]> {
    const res = await pub(clinic.host)
      .slots(
        {
          locationId,
          appointmentTypeId: typeId,
          patientKind: kind,
          from: DAY,
          days: '1',
        },
        session,
      )
      .expect(200);
    return (res.body as { slots: Slot[] }).slots;
  }

  const newPatient = (over: object = {}) => ({
    firstName: 'Luis',
    lastName: 'Rodríguez',
    birthDate: '1988-02-03',
    email: 'luis.rodriguez@example.com',
    phone: '04125550101',
    consentPolicyVersionId: policyId,
    consentAccepted: true,
    ...over,
  });

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
        builder
          .overrideProvider(ONLINE_BOOKING_CLOCK)
          .useValue(() => new Date(Date.now() + skewMs));
      },
    });
    clinic = await registerClinic(app, 'dx016-reserva');
    other = await registerClinic(app, 'dx016-otra');
    locationId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
      })
    ).id;
    typeId = (
      await raw.appointmentType.create({
        data: {
          tenantId: clinic.tenantId,
          name: 'Limpieza dental',
          durationMinutes: 45,
          color: '#0E7490',
        },
      })
    ).id;
    policyId = (
      await raw.privacyPolicyVersion.create({
        data: {
          tenantId: clinic.tenantId,
          version: 1,
          policyText: 'Política de la clínica',
          generalText: 'Autorizo el tratamiento de mis datos',
          sensitiveHealthText: 's',
          marketingText: 'm',
          contentHash: 'h',
          publishedById: clinic.adminUserId,
        },
      })
    ).id;
    const reception = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    receptionToken = await loginAs(app, clinic.host, reception.email);
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('desactivada por defecto: la página da el mismo 404 que un host sin clínica', async () => {
    const off = await pub(clinic.host).config().expect(404);
    const unknown = await pub('nadie.localhost').config().expect(404);
    expect((off.body as { message: string }).message).toBe(
      (unknown.body as { message: string }).message,
    );
    const settings = await staff(clinic.adminToken)
      .get('/online-booking/settings')
      .expect(200);
    expect((settings.body as { enabled: boolean }).enabled).toBe(false);
  });

  it('solo el ADMIN cambia ajustes y tipos; ambos quedan en la auditoría', async () => {
    await staff(receptionToken)
      .put('/online-booking/settings', { enabled: true })
      .expect(403);
    await enable();
    await staff(clinic.adminToken)
      .put(`/online-booking/types/${typeId}`, {
        visibleOnline: true,
        durationNewMinutes: 60,
        durationExistingMinutes: null,
        providerIds: [],
        locationIds: [],
      })
      .expect(200);
    // Un tipo de otra clínica es invisible: 404.
    const foreignType = await raw.appointmentType.create({
      data: {
        tenantId: other.tenantId,
        name: 'Ajena',
        durationMinutes: 30,
        color: '#111111',
      },
    });
    await staff(clinic.adminToken)
      .put(`/online-booking/types/${foreignType.id}`, {
        visibleOnline: true,
        durationNewMinutes: null,
        durationExistingMinutes: null,
        providerIds: [],
        locationIds: [],
      })
      .expect(404);
    const events = await raw.auditEvent.findMany({
      where: { tenantId: clinic.tenantId, actorUserId: clinic.adminUserId },
      select: { resourceType: true, metadata: true },
    });
    const reasons = events.map(
      (e) => (e.metadata as { reason?: string }).reason,
    );
    expect(reasons).toEqual(
      expect.arrayContaining([
        'ONLINE_BOOKING_SETTINGS',
        'ONLINE_BOOKING_TYPE',
      ]),
    );
  });

  it('la página ofrece sede, tipo, profesional y la política; nada de la agenda', async () => {
    const res = await pub(clinic.host).config().expect(200);
    const body = res.body as {
      locations: {
        id: string;
        timeZone: string;
        locale: string | null;
        hourCycle: string | null;
      }[];
      types: {
        id: string;
        durationNewMinutes: number;
        durationExistingMinutes: number;
      }[];
      providers: { id: string }[];
      privacyPolicy: { id: string } | null;
      newPatientMode: string;
    };
    expect(body.locations.map((l) => l.id)).toEqual([locationId]);
    expect(body.locations[0].timeZone).toBe('America/Caracas');
    // Con el formato de la sede: la página escribe las horas con él.
    expect(typeof body.locations[0].locale).toBe('string');
    expect(body.locations[0].hourCycle).toMatch(/^h(12|23)$/);
    expect(body.types).toEqual([
      expect.objectContaining({
        id: typeId,
        durationNewMinutes: 60,
        durationExistingMinutes: 45,
      }),
    ]);
    expect(body.providers.map((p) => p.id)).toEqual([clinic.adminUserId]);
    expect(body.privacyPolicy?.id).toBe(policyId);
    expect(body.newPatientMode).toBe('DIRECT');
    // Otra clínica (su host) no ve nada de esta: sigue desactivada.
    await pub(other.host).config().expect(404);
  });

  it('los huecos caben en el horario de la sede, no se solapan con citas y no llevan nombres', async () => {
    const patient = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: 'Ocupante',
        lastName: 'Secreto',
      },
    });
    await raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        patientId: patient.id,
        providerId: clinic.adminUserId,
        start: local('10:00'),
        end: local('10:30'),
      },
    });
    const res = await pub(clinic.host)
      .slots({
        locationId,
        appointmentTypeId: typeId,
        patientKind: 'NEW',
        from: DAY,
        days: '1',
      })
      .expect(200);
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/Ocupante|Secreto/);
    const slots = (res.body as { slots: Slot[] }).slots;
    // Horario de alta: 9–13 y 15–19; 60 min cada 30. La cita de 10:00–10:30
    // quita 9:30 y 10:00.
    expect(slots.map((s) => new Date(s.start).getTime())).toEqual(
      [
        '09:00',
        '10:30',
        '11:00',
        '11:30',
        '12:00',
        '15:00',
        '15:30',
        '16:00',
        '16:30',
        '17:00',
        '17:30',
        '18:00',
      ].map((h) => local(h).getTime()),
    );
    expect(Object.keys(slots[0]).sort()).toEqual([
      'end',
      'providerId',
      'start',
    ]);
  });

  it('protección anti-bots: campo trampa, envío demasiado rápido y sin token', async () => {
    const [slot] = await slotsOn();
    const base = {
      locationId,
      appointmentTypeId: typeId,
      start: slot.start,
      newPatient: newPatient(),
    };
    const token = await formToken();
    await pub(clinic.host)
      .book({ ...base, formToken: token, website: 'http://spam.example' })
      .expect(400);
    await pub(clinic.host)
      .book({ ...base, formToken: 'nada' })
      .expect(400);
    const fresh = (await pub(clinic.host).config().expect(200)).body as {
      formToken: string;
    };
    const fast = await pub(clinic.host)
      .book({ ...base, formToken: fresh.formToken })
      .expect(400);
    expect((fast.body as { message: string }).message).toMatch(
      /demasiado rápido/,
    );
    expect(
      await raw.patient.count({
        where: { tenantId: clinic.tenantId, lastName: 'Rodríguez' },
      }),
    ).toBe(0);
  });

  it('paciente nuevo, reserva directa: la cita queda ONLINE en la agenda, con ficha, consentimiento, auditoría y enlace DX-005', async () => {
    const [slot] = await slotsOn();
    const res = await pub(clinic.host)
      .book({
        locationId,
        appointmentTypeId: typeId,
        start: slot.start,
        newPatient: newPatient(),
        formToken: await formToken(),
      })
      .expect(201);
    const body = res.body as {
      status: string;
      manageUrl: string | null;
      providerName: string;
    };
    expect(body.status).toBe('BOOKED');
    expect(body.manageUrl).toMatch(/\/confirmar\/[A-Za-z0-9_-]+$/);

    const patient = await raw.patient.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, lastName: 'Rodríguez' },
    });
    expect(patient.email).toBe('luis.rodriguez@example.com');
    const consent = await raw.dataProcessingConsent.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, patientId: patient.id },
    });
    expect(consent).toMatchObject({
      channel: 'PATIENT_LINK',
      scope: 'GENERAL',
      granted: true,
      policyVersionId: policyId,
    });

    // La agenda la enseña marcada como online.
    const agenda = await staff(receptionToken)
      .get(
        `/appointments?from=${DAY}T00:00:00${TZ_OFFSET}&to=${DAY}T23:59:00${TZ_OFFSET}`,
      )
      .expect(200);
    const items = (
      Array.isArray(agenda.body)
        ? agenda.body
        : (agenda.body as { items: unknown[] }).items
    ) as {
      patientId: string;
      origin: string;
      start: string;
    }[];
    const online = items.find((a) => a.patientId === patient.id);
    expect(online).toMatchObject({ origin: 'ONLINE', start: slot.start });

    const reasons = (
      await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          patientId: patient.id,
          actorUserId: null,
        },
        select: { resourceType: true, action: true, metadata: true },
      })
    ).map(
      (e) =>
        `${e.action} ${e.resourceType} ${(e.metadata as { reason: string }).reason}`,
    );
    expect(reasons.sort()).toEqual(
      [
        'CREATE APPOINTMENT ONLINE_BOOKING_BOOKED',
        'CREATE DATA_CONSENT ONLINE_BOOKING_CONSENT',
        'CREATE ONLINE_BOOKING ONLINE_BOOKING_BOOKED',
        'CREATE PATIENT ONLINE_BOOKING_PATIENT_CREATED',
      ].sort(),
    );
    await mailer.waitFor('luis.rodriguez@example.com', /quedó reservada/);

    // Ese hueco ya no se ofrece; pedirlo de nuevo es un 409 claro.
    expect((await slotsOn()).map((s) => s.start)).not.toContain(slot.start);
    const again = await pub(clinic.host)
      .book({
        locationId,
        appointmentTypeId: typeId,
        start: slot.start,
        newPatient: newPatient({
          firstName: 'Ana',
          lastName: 'Gómez',
          email: 'ana.gomez@example.com',
          birthDate: '1992-07-09',
        }),
        formToken: await formToken(),
      })
      .expect(409);
    expect((again.body as { code: string }).code).toBe('ONLINE_SLOT_GONE');
  });

  it('un «nuevo» parecido a una ficha responde igual que uno sin parecido (no revela quién es paciente) y queda marcado para fusionar', async () => {
    // Directa (como está la clínica): mismo estado y misma forma.
    const slots = await slotsOn();
    const book = async (start: string, over: object) =>
      pub(clinic.host)
        .book({
          locationId,
          appointmentTypeId: typeId,
          start,
          newPatient: newPatient(over),
          formToken: await formToken(),
        })
        .expect(201);
    const lookalike = await book(slots[0].start, {
      email: 'otro.email@example.com',
      phone: '04145550199',
    });
    // Otro hueco que no se solape con el primero (60 min cada 30).
    const next = slots.find(
      (x) => new Date(x.start).getTime() >= new Date(slots[0].end).getTime(),
    )!;
    const stranger = await book(next.start, {
      firstName: 'Carmen',
      lastName: 'Briceño',
      birthDate: '1975-11-30',
      email: 'carmen.briceno@example.com',
      phone: '04245550142',
    });
    const shape = (b: Record<string, unknown>) => ({
      keys: Object.keys(b).sort(),
      status: b.status,
      hasManageUrl: typeof b.manageUrl === 'string',
    });
    expect(shape(lookalike.body as Record<string, unknown>)).toEqual(
      shape(stranger.body as Record<string, unknown>),
    );
    // Se crea la ficha nueva (nunca se escribe a la de la ficha existente)
    // y la reserva queda marcada para que recepción la fusione (DX-266).
    expect(
      await raw.patient.count({
        where: { tenantId: clinic.tenantId, lastName: 'Rodríguez' },
      }),
    ).toBe(2);
    const marked = await raw.onlineBookingRequest.findFirstOrThrow({
      where: {
        tenantId: clinic.tenantId,
        contactEmail: 'otro.email@example.com',
      },
    });
    expect(marked).toMatchObject({ possibleDuplicate: true, status: 'BOOKED' });
    expect(
      mailer.sent.some(
        (m) =>
          m.to === 'luis.rodriguez@example.com' &&
          /otro|04145550199/.test(m.text),
      ),
    ).toBe(false);
    await mailer.waitFor('otro.email@example.com', /quedó reservada/);

    // En modo solicitud, la reserva marcada queda pendiente para recepción.
    await enable({ newPatientMode: 'REQUEST' });
    const [later] = await slotsOn();
    const requested = await book(later.start, {
      email: 'tercer.email@example.com',
      phone: '04165550177',
    });
    expect((requested.body as { status: string }).status).toBe('REQUESTED');
    const pending = await raw.onlineBookingRequest.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, status: 'PENDING' },
    });
    expect(pending).toMatchObject({
      possibleDuplicate: true,
      contactEmail: 'tercer.email@example.com',
    });
    await enable();
  });

  it('paciente existente: el código por email (sin revelar si existe), la sesión, la solicitud y recepción la acepta', async () => {
    const existing = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: 'María José',
        lastName: 'Pérez',
        birthDate: new Date('1990-05-14T00:00:00Z'),
        email: 'maria.perez@example.com',
      },
    });
    // DX-465: tiene un Control vencido con un intento, y el tipo de la
    // reserva es el de su recall: al aceptarla se cierra el ciclo.
    const checkupType = await raw.recallType.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, systemKey: 'CHECKUP' },
      select: { id: true },
    });
    await raw.recallType.update({
      where: { id: checkupType.id },
      data: { appointmentTypeId: typeId },
    });
    const owner = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, role: ClinicRole.ADMIN },
      select: { userId: true },
    });
    const recall = await raw.patientRecall.create({
      data: {
        tenantId: clinic.tenantId,
        patientId: existing.id,
        recallTypeId: checkupType.id,
        intervalMonths: 12,
        lastDoneAt: new Date('2025-01-15T00:00:00Z'),
        locationId,
        createdById: owner.userId,
        updatedById: owner.userId,
        attemptCount: 2,
        lastAttemptAt: new Date(),
        cycleDueAt: new Date('2026-01-15T00:00:00Z'),
      },
    });
    const who = {
      firstName: 'maria jose',
      lastName: 'PEREZ',
      birthDate: '1990-05-14',
      email: 'Maria.Perez@example.com',
    };
    const sent = await pub(clinic.host)
      .code({ ...who, formToken: await formToken() })
      .expect(200);
    const nobody = await pub(clinic.host)
      .code({ ...who, birthDate: '1991-05-14', formToken: await formToken() })
      .expect(200);
    expect(Object.keys(sent.body as object).sort()).toEqual(
      Object.keys(nobody.body as object).sort(),
    );
    expect((sent.body as { message: string }).message).toBe(
      (nobody.body as { message: string }).message,
    );

    const match = await mailer.waitFor(
      'maria.perez@example.com',
      /código de verificación es: (\d{6})/,
    );
    const code = match[1];
    const { verificationId } = sent.body as { verificationId: string };
    const wrong = code === '000000' ? '111111' : '000000';
    await pub(clinic.host).verify(verificationId, wrong).expect(400);
    // El de los datos que no casan no se puede verificar con ningún código.
    await pub(clinic.host)
      .verify((nobody.body as { verificationId: string }).verificationId, code)
      .expect(400);
    // Desde el host de otra clínica, la verificación no existe.
    await pub(other.host).verify(verificationId, code).expect(404);
    const verified = await pub(clinic.host)
      .verify(verificationId, code)
      .expect(200);
    const { sessionToken } = verified.body as { sessionToken: string };
    // Un solo uso.
    await pub(clinic.host).verify(verificationId, code).expect(400);

    const [slot] = await slotsOn(sessionToken, 'EXISTING');
    const booked = await pub(clinic.host)
      .book(
        {
          locationId,
          appointmentTypeId: typeId,
          start: slot.start,
          formToken: await formToken(),
        },
        sessionToken,
      )
      .expect(201);
    expect((booked.body as { status: string }).status).toBe('REQUESTED');
    // La sesión ya se gastó.
    await pub(clinic.host)
      .book(
        {
          locationId,
          appointmentTypeId: typeId,
          start: slot.start,
          formToken: await formToken(),
        },
        sessionToken,
      )
      .expect(401);
    expect(
      await raw.patient.count({
        where: { tenantId: clinic.tenantId, lastName: 'Pérez' },
      }),
    ).toBe(1);

    // Recepción: bandeja y contador; aceptar crea la cita ONLINE.
    const count = await staff(receptionToken)
      .get('/online-booking/requests/pending-count')
      .expect(200);
    expect((count.body as { pending: number }).pending).toBe(2);
    const inbox = await staff(receptionToken)
      .get('/online-booking/requests?status=PENDING')
      .expect(200);
    const mine = (
      inbox.body as { items: { id: string; patient: { id: string } }[] }
    ).items.find((r) => r.patient.id === existing.id)!;
    const accepted = await staff(receptionToken)
      .post(`/online-booking/requests/${mine.id}/accept`)
      .expect(200);
    expect((accepted.body as { status: string }).status).toBe('ACCEPTED');
    const appointment = await raw.appointment.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, patientId: existing.id },
    });
    expect(appointment.origin).toBe('ONLINE');
    // DX-465: la acepta recepción (con usuario): «Agendó» con la cita y el
    // ciclo cerrado.
    await expect(
      raw.recallContact.findMany({
        where: { recallId: recall.id, outcome: 'BOOKED' },
        select: { appointmentId: true, authorId: true },
      }),
    ).resolves.toEqual([
      { appointmentId: appointment.id, authorId: appointment.createdById },
    ]);
    await expect(
      raw.patientRecall.findUniqueOrThrow({
        where: { id: recall.id },
        select: { attemptCount: true },
      }),
    ).resolves.toEqual({ attemptCount: 0 });
    // Otra vez: ya resuelta.
    await staff(receptionToken)
      .post(`/online-booking/requests/${mine.id}/accept`)
      .expect(409);
    // Desde otra clínica, la solicitud no existe.
    await staff(other.adminToken, other.host)
      .post(`/online-booking/requests/${mine.id}/decline`)
      .expect(404);

    const dup = (
      inbox.body as { items: { id: string; patient: { id: string } }[] }
    ).items.find((r) => r.patient.id !== existing.id)!;
    const declined = await staff(receptionToken)
      .post(`/online-booking/requests/${dup.id}/decline`)
      .expect(200);
    expect((declined.body as { status: string }).status).toBe('DECLINED');
  });

  // ISOLATION_COVERS: PUT /online-booking/types/:appointmentTypeId
  // ISOLATION_COVERS: POST /online-booking/requests/:id/accept
  // ISOLATION_COVERS: POST /online-booking/requests/:id/decline
  it('B → 404 al configurar el tipo de A, y al aceptar o rechazar una solicitud de A; nada de A cambia', async () => {
    const before = await raw.onlineBookingRequest.findMany({
      where: { tenantId: clinic.tenantId },
      orderBy: { id: 'asc' },
    });
    const typeBefore = await raw.appointmentTypeOnlineSettings.findMany({
      where: { tenantId: clinic.tenantId },
    });
    const asB = staff(other.adminToken, other.host);
    await asB
      .put(`/online-booking/types/${typeId}`, {
        visibleOnline: false,
        durationNewMinutes: null,
        durationExistingMinutes: null,
        providerIds: [],
        locationIds: [],
      })
      .expect(404);
    for (const r of before) {
      await asB.post(`/online-booking/requests/${r.id}/accept`).expect(404);
      await asB.post(`/online-booking/requests/${r.id}/decline`).expect(404);
    }
    expect(before.length).toBeGreaterThan(0);
    expect(
      await raw.onlineBookingRequest.findMany({
        where: { tenantId: clinic.tenantId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before);
    expect(
      await raw.appointmentTypeOnlineSettings.findMany({
        where: { tenantId: clinic.tenantId },
      }),
    ).toEqual(typeBefore);
  });

  it('cinco fallos bloquean el código', async () => {
    const who = {
      firstName: 'María José',
      lastName: 'Pérez',
      birthDate: '1990-05-14',
      email: 'maria.perez@example.com',
    };
    const sent = await pub(clinic.host)
      .code({ ...who, formToken: await formToken() })
      .expect(200);
    const code = (
      await mailer.waitFor(
        'maria.perez@example.com',
        /código de verificación es: (\d{6})/,
      )
    )[1];
    const { verificationId } = sent.body as { verificationId: string };
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      await pub(clinic.host).verify(verificationId, wrong).expect(400);
    await pub(clinic.host).verify(verificationId, code).expect(400);
    const row = await raw.onlineBookingVerification.findUniqueOrThrow({
      where: { id: verificationId },
    });
    expect(row.lockedAt).not.toBeNull();
  });

  it('la clínica puede desactivarla por completo', async () => {
    await enable({ enabled: false });
    await pub(clinic.host).config().expect(404);
    await pub(clinic.host)
      .slots({
        locationId,
        appointmentTypeId: typeId,
        patientKind: 'NEW',
        from: DAY,
        days: '1',
      })
      .expect(404);
  });
});
