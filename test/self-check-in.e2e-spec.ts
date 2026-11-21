import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { hashPublicLinkToken } from '../src/shared/public-links/public-link-token';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { locationBody } from './support/location-fixtures';
import { sedeTodayFixture } from './support/sede-clock';

// DX-265 en HTTP real: «Ya llegué». Desde el enlace de la cita (DX-005) y con
// el QR de la sede (documento + fecha de nacimiento, solo citas de hoy en esa
// sede). La llegada pasa por el MISMO camino que la de recepción (estado,
// hora, turno del día) y queda auditada con su origen; «En clínica» la marca
// y lista sus pendientes. Ventana configurable, idempotencia, respuestas
// uniformes, bloqueo por fallos y aislamiento entre clínicas y sedes.
//
// Las citas de hoy: se agendan por la API lejos (en 3 días) y se traen con
// `raw` a «hace/dentro de N minutos» en una sede cuya zona está lejos de su
// medianoche (DX-449), corra la suite a la hora que corra.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const MIN = 60_000;
const DAY_MS = 24 * 60 * MIN;

/** Las ÚNICAS claves de la vista pública (lista blanca). */
const VIEW_KEYS = [
  'appointment',
  'closesAt',
  'opensAt',
  'result',
  'state',
  'turnNumber',
];
const APPOINTMENT_KEYS = [
  'hourCycle',
  'locale',
  'locationName',
  'patientFirstName',
  'start',
  'timeZone',
];
const NO_MATCH = {
  statusCode: 400,
  error: 'Bad Request',
  code: 'CHECK_IN_NO_MATCH',
  message:
    'No encontramos una cita para hoy en esta sede con esos datos. Revisa el documento y la fecha de nacimiento, o pasa por recepción.',
};
const QR_INACTIVE = {
  statusCode: 404,
  error: 'Not Found',
  code: 'CHECK_IN_QR_INACTIVE',
  message: 'Este código ya no está activo. Pasa por recepción.',
};

interface ArrivalBody {
  state: string;
  opensAt: string | null;
  closesAt: string | null;
  result: string | null;
  turnNumber: number | null;
  appointment: Record<string, unknown> | null;
}

function expectWhitelisted(body: unknown): void {
  const view = body as Record<string, unknown>;
  expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
  if (view.appointment !== null) {
    expect(
      Object.keys(view.appointment as Record<string, unknown>).sort(),
    ).toEqual(APPOINTMENT_KEYS);
  }
}

describe('«Ya llegué» (e2e, DX-265)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let reception: { userId: string; token: string };
  let dentistId: string;
  let chacao: string;
  let altamira: string;
  let patientN = 0;

  const api = () => request(app.getHttpServer());
  const as = (
    req: request.Test,
    token: string,
    locationId?: string,
    host = clinic.host,
  ) => {
    const r = req
      .set('X-Tenant-Host', host)
      .set('Authorization', `Bearer ${token}`);
    return locationId ? r.set('X-Location-Id', locationId) : r;
  };
  const linkView = (token: string, host = clinic.host) =>
    api()
      .get(`/api/v1/public/appointment-confirmations/${token}/arrival`)
      .set('X-Tenant-Host', host);
  const linkArrive = (token: string, host = clinic.host) =>
    api()
      .post(`/api/v1/public/appointment-confirmations/${token}/arrival`)
      .set('X-Tenant-Host', host)
      .set('User-Agent', 'Telefono del paciente');
  const qrView = (token: string, host = clinic.host) =>
    api().get(`/api/v1/public/check-in/${token}`).set('X-Tenant-Host', host);
  const qrIdentify = (
    token: string,
    body: { documentNumber: string; birthDate: string },
    host = clinic.host,
    ip?: string,
  ) => {
    const r = api()
      .post(`/api/v1/public/check-in/${token}`)
      .set('X-Tenant-Host', host);
    return (ip ? r.set('X-Forwarded-For', ip) : r).send(body);
  };

  async function patient(
    firstName: string,
    docNumber: string,
    birthDate = '1990-04-15',
  ): Promise<string> {
    const p = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName,
        lastName: 'Rodríguez Pérez',
        documentType: 'NATIONAL_ID',
        docNumber,
        birthDate: new Date(`${birthDate}T00:00:00.000Z`),
        phone: '+584121234567',
      },
    });
    return p.id;
  }

  /**
   * Una cita de HOY en la sede que empieza dentro de `offsetMin` minutos
   * (negativo: ya empezó). Con su enlace de confirmación emitido antes de
   * traerla a hoy.
   */
  async function bookToday(
    patientId: string,
    locationId: string,
    offsetMin: number,
  ): Promise<{ id: string; token: string }> {
    patientN++;
    const later = new Date(Date.now() + 3 * DAY_MS + patientN * 45 * MIN);
    const res = await as(
      api().post('/api/v1/appointments'),
      reception.token,
      locationId,
    )
      .send({
        patientId,
        providerId: dentistId,
        start: later.toISOString(),
        end: new Date(later.getTime() + 10 * MIN).toISOString(),
        reason: 'Endodoncia molar 36',
      })
      .expect(201);
    const id = (res.body as { id: string }).id;
    const link = await as(
      api().post(`/api/v1/appointments/${id}/confirmation-link`),
      reception.token,
    ).expect(201);
    const token = (link.body as { url: string }).url.split('/confirmar/')[1];
    // Cada cita en su propio tramo de 7 s (y de 5 s): sin solapes del
    // profesional. Los desfases de los casos van de 5 en 5 minutos y el
    // corrimiento (< 2 min) no saca ninguna de su caso.
    const start = new Date(Date.now() + offsetMin * MIN + patientN * 7000);
    await raw.appointment.update({
      where: { id },
      data: { start, end: new Date(start.getTime() + 5000) },
    });
    return { id, token };
  }

  const auditOf = (appointmentId: string) =>
    raw.auditEvent.findMany({
      where: {
        resourceType: 'APPOINTMENT',
        resourceId: appointmentId,
        metadata: { path: ['reason'], equals: 'PATIENT_SELF_CHECK_IN' },
      },
    });

  beforeAll(async () => {
    app = await createE2eApp();
    // Un salto de proxy de confianza, como en producción: cada «cliente» de
    // las pruebas de bloqueo es una IP distinta por X-Forwarded-For (sin la
    // cabecera, la de supertest).
    (
      app.getHttpAdapter().getInstance() as { set(k: string, v: number): void }
    ).set('trust proxy', 1);
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx265-e2e');
    other = await registerClinic(app, 'dx265-e2e-otra');
    const d = await seedMember(raw, clinic, ClinicRole.DENTIST);
    dentistId = d.userId;
    const r = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    reception = {
      userId: r.userId,
      token: await loginAs(app, clinic.host, r.email),
    };
    const fixture = sedeTodayFixture();
    const createLocation = async (name: string) =>
      (
        (
          await as(api().post('/api/v1/locations'), clinic.adminToken)
            .send(locationBody(fixture, { name }))
            .expect(201)
        ).body as { id: string }
      ).id;
    chacao = await createLocation('Sede Chacao');
    altamira = await createLocation('Sede Altamira');
    for (const locationId of [chacao, altamira]) {
      await as(
        api().put('/api/v1/locations/schedule'),
        clinic.adminToken,
        locationId,
      )
        .send({
          ranges: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
            weekday,
            startMinute: 0,
            endMinute: 1440,
          })),
        })
        .expect(200);
    }
  }, 90_000);

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  describe('desde el enlace de la cita', () => {
    it('dentro de la ventana: llega por el mismo camino que recepción, con turno, origen y auditoría; idempotente', async () => {
      const patientId = await patient('Ana María', 'V-11111111');
      const appt = await bookToday(patientId, chacao, 5);

      const before = await linkView(appt.token).expect(200);
      expectWhitelisted(before.body);
      expect(before.body).toMatchObject({
        state: 'AVAILABLE',
        result: null,
        turnNumber: null,
        appointment: { patientFirstName: 'Ana', locationName: 'Sede Chacao' },
      });
      // Solo el nombre de pila: ni apellidos, ni motivo.
      expect(JSON.stringify(before.body)).not.toMatch(
        /Rodríguez|Endodoncia|V-1111/,
      );

      const res = await linkArrive(appt.token).expect(200);
      expectWhitelisted(res.body);
      const body = res.body as ArrivalBody;
      // Sin anamnesis: «Pase por recepción» (sin decir por qué).
      expect(body).toMatchObject({
        state: 'ARRIVED',
        result: 'SEE_RECEPTION',
      });
      expect(body.turnNumber).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(body)).not.toMatch(/ANAMNESIS|CONSENT|LATE/);

      const row = await raw.appointment.findUniqueOrThrow({
        where: { id: appt.id },
      });
      expect(row).toMatchObject({
        status: 'ARRIVED',
        preArrivalStatus: 'SCHEDULED',
        arrivalSource: 'PATIENT_LINK',
        turnNumber: body.turnNumber,
      });
      expect(row.arrivedAt).not.toBeNull();

      const events = await auditOf(appt.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorUserId: null,
        actorRole: null,
        action: 'UPDATE',
        patientId,
        locationId: chacao,
      });
      expect(events[0].metadata).toMatchObject({
        origin: 'PATIENT_LINK',
        reason: 'PATIENT_SELF_CHECK_IN',
        status: { from: 'SCHEDULED', to: 'ARRIVED' },
      });
      expect(JSON.stringify(events[0])).not.toContain(appt.token);

      // Otra vez: lo mismo, sin otro evento ni otro turno.
      const again = await linkArrive(appt.token).expect(200);
      expect(again.body).toMatchObject({
        state: 'ARRIVED',
        turnNumber: body.turnNumber,
      });
      expect(await auditOf(appt.id)).toHaveLength(1);

      // «En clínica»: marca distinta y su lista de pendientes.
      const panel = await as(
        api().get('/api/v1/appointments/in-clinic'),
        reception.token,
        chacao,
      ).expect(200);
      const item = (
        panel.body as {
          waiting: {
            appointmentId: string;
            arrivalSource: string | null;
            checkInPending: string[];
          }[];
        }
      ).waiting.find((w) => w.appointmentId === appt.id);
      expect(item).toMatchObject({
        arrivalSource: 'PATIENT_LINK',
        checkInPending: expect.arrayContaining([
          'ANAMNESIS',
          'CONSENT',
        ]) as unknown,
      });
    });

    it('fuera de la ventana: 409 en español y nada cambia; la ventana es la de la sede', async () => {
      const patientId = await patient('Luis', 'V-22222222');
      const early = await bookToday(patientId, chacao, 90);
      const view = await linkView(early.token).expect(200);
      expect(view.body).toMatchObject({ state: 'TOO_EARLY' });
      const res = await linkArrive(early.token).expect(409);
      expect((res.body as { message: string }).message).toMatch(
        /Aún es pronto/,
      );
      expect(
        (await raw.appointment.findUniqueOrThrow({ where: { id: early.id } }))
          .status,
      ).toBe('SCHEDULED');
      expect(await auditOf(early.id)).toHaveLength(0);

      // ADMIN abre la ventana a 120 min antes: ya se puede.
      await as(
        api().patch(`/api/v1/locations/${chacao}/check-in-settings`),
        clinic.adminToken,
      )
        .send({ minutesBefore: 120 })
        .expect(200);
      const now = await linkArrive(early.token).expect(200);
      expect(now.body).toMatchObject({ state: 'ARRIVED' });
      await as(
        api().patch(`/api/v1/locations/${chacao}/check-in-settings`),
        clinic.adminToken,
      )
        .send({ minutesBefore: 30 })
        .expect(200);

      const latePatient = await patient('Carmen', 'V-33333333');
      const late = await bookToday(latePatient, chacao, -45);
      expect((await linkView(late.token).expect(200)).body).toMatchObject({
        state: 'TOO_LATE',
      });
      const lateRes = await linkArrive(late.token).expect(409);
      expect((lateRes.body as { message: string }).message).toMatch(
        /recepción/,
      );
    });

    it('llegar tarde (sobre el umbral) manda a recepción y queda como pendiente LATE', async () => {
      const patientId = await patient('Pedro', 'V-44444444');
      const appt = await bookToday(patientId, chacao, -20);
      const res = await linkArrive(appt.token).expect(200);
      expect(res.body).toMatchObject({
        state: 'ARRIVED',
        result: 'SEE_RECEPTION',
      });
      const panel = await as(
        api().get('/api/v1/appointments/in-clinic'),
        reception.token,
        chacao,
      ).expect(200);
      const item = (
        panel.body as {
          waiting: { appointmentId: string; checkInPending: string[] }[];
        }
      ).waiting.find((w) => w.appointmentId === appt.id);
      expect(item?.checkInPending).toContain('LATE');
    });

    it('la sede que no lo ofrece por enlace: UNAVAILABLE sin datos de la cita, y 409', async () => {
      await as(
        api().patch(`/api/v1/locations/${altamira}/check-in-settings`),
        clinic.adminToken,
      )
        .send({ linkEnabled: false })
        .expect(200);
      const patientId = await patient('Rosa', 'V-55555555');
      const appt = await bookToday(patientId, altamira, 0);
      const view = await linkView(appt.token).expect(200);
      expectWhitelisted(view.body);
      expect(view.body).toEqual({
        state: 'UNAVAILABLE',
        opensAt: null,
        closesAt: null,
        result: null,
        turnNumber: null,
        appointment: null,
      });
      await linkArrive(appt.token).expect(409);
      await as(
        api().patch(`/api/v1/locations/${altamira}/check-in-settings`),
        clinic.adminToken,
      )
        .send({ linkEnabled: true })
        .expect(200);
    });

    // ISOLATION_COVERS: GET /public/appointment-confirmations/:token/arrival
    // ISOLATION_COVERS: POST /public/appointment-confirmations/:token/arrival
    it('aislamiento: el enlace de la clínica A en el host de B es el mismo 404 que uno inventado', async () => {
      const patientId = await patient('Elena', 'V-66666666');
      const appt = await bookToday(patientId, chacao, 0);
      const cross = await linkArrive(appt.token, other.host).expect(404);
      const invented = await linkArrive('A'.repeat(43)).expect(404);
      expect(cross.body).toEqual(invented.body);
      await linkView(appt.token, other.host).expect(404);
      expect(
        (await raw.appointment.findUniqueOrThrow({ where: { id: appt.id } }))
          .status,
      ).toBe('SCHEDULED');
    });
  });

  describe('con el QR de la sede', () => {
    let qrChacao: string;
    let secondQr: string;

    it('solo ADMIN gestiona los ajustes y el QR; el token sale una vez y en la BD queda su hash', async () => {
      await as(
        api().get(`/api/v1/locations/${chacao}/check-in-settings`),
        reception.token,
      ).expect(403);
      await as(
        api().post(`/api/v1/locations/${chacao}/check-in-settings/qr`),
        reception.token,
      ).expect(403);
      await as(
        api().patch(`/api/v1/locations/${chacao}/check-in-settings`),
        clinic.adminToken,
      )
        .send({ minutesAfter: 241 })
        .expect(400);

      const created = await as(
        api().post(`/api/v1/locations/${chacao}/check-in-settings/qr`),
        clinic.adminToken,
      ).expect(201);
      qrChacao = (created.body as { token: string }).token;
      expect(qrChacao).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const settings = await as(
        api().get(`/api/v1/locations/${chacao}/check-in-settings`),
        clinic.adminToken,
      ).expect(200);
      expect(settings.body).toMatchObject({ qrActive: true });
      expect(settings.body).not.toHaveProperty('token');
      const row = await raw.locationCheckInSettings.findFirstOrThrow({
        where: { locationId: chacao },
      });
      expect(row.qrTokenHash).toBe(hashPublicLinkToken(qrChacao));
      const events = await raw.auditEvent.findMany({
        where: {
          resourceType: 'LOCATION',
          resourceId: chacao,
          metadata: { path: ['reason'], equals: 'CHECK_IN_QR_CREATED' },
        },
      });
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(qrChacao);

      const page = await qrView(qrChacao).expect(200);
      expect(page.body).toMatchObject({ locationName: 'Sede Chacao' });
      expect(Object.keys(page.body as object).sort()).toEqual([
        'clinic',
        'hourCycle',
        'locale',
        'locationName',
        'timeZone',
      ]);
    });

    it('documento + fecha de nacimiento: marca la llegada de SU cita de hoy en ESA sede (origen SEDE_QR)', async () => {
      const patientId = await patient('Josefina', 'V-77.777.777', '1985-12-01');
      const appt = await bookToday(patientId, chacao, 10);
      // Solo dígitos vale por «V-77.777.777».
      const res = await qrIdentify(qrChacao, {
        documentNumber: '77777777',
        birthDate: '1985-12-01',
      }).expect(200);
      expectWhitelisted(res.body);
      expect(res.body).toMatchObject({
        state: 'ARRIVED',
        result: 'SEE_RECEPTION',
        appointment: { patientFirstName: 'Josefina' },
      });
      const row = await raw.appointment.findUniqueOrThrow({
        where: { id: appt.id },
      });
      expect(row).toMatchObject({
        status: 'ARRIVED',
        arrivalSource: 'SEDE_QR',
      });
      const events = await auditOf(appt.id);
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toMatchObject({ origin: 'SEDE_QR' });
      expect(JSON.stringify(events[0])).not.toMatch(/77777777|1985-12-01/);
      // Repetir: idempotente.
      await qrIdentify(qrChacao, {
        documentNumber: 'V-77777777',
        birthDate: '1985-12-01',
      }).expect(200);
      expect(await auditOf(appt.id)).toHaveLength(1);
    });

    it('la MISMA respuesta exista o no el paciente: fecha mala, cita en otra sede, cita otro día o nadie', async () => {
      const inAltamira = await patient('Teresa', 'V-88888888', '1970-01-20');
      await bookToday(inAltamira, altamira, 0);
      const tomorrow = await patient('Marta', 'V-99999999', '1975-05-05');
      const t = await bookToday(tomorrow, chacao, 0);
      await raw.appointment.update({
        where: { id: t.id },
        data: {
          start: new Date(Date.now() + 2 * DAY_MS),
          end: new Date(Date.now() + 2 * DAY_MS + MIN),
        },
      });
      const attempts = [
        { documentNumber: 'V-77777777', birthDate: '1985-12-02' },
        { documentNumber: 'V-88888888', birthDate: '1970-01-20' },
        { documentNumber: 'V-99999999', birthDate: '1975-05-05' },
        { documentNumber: 'V-10101010', birthDate: '1999-09-09' },
      ];
      for (const body of attempts) {
        const res = await qrIdentify(qrChacao, body).expect(400);
        expect(res.body).toEqual(NO_MATCH);
      }
    });

    // ISOLATION_COVERS: GET /public/check-in/:token
    // ISOLATION_COVERS: POST /public/check-in/:token
    it('aislamiento: el QR de A en el host de B, uno inventado o uno retirado dan el mismo 404', async () => {
      expect((await qrView(qrChacao, other.host).expect(404)).body).toEqual(
        QR_INACTIVE,
      );
      expect(
        (
          await qrIdentify(
            qrChacao,
            { documentNumber: 'V-77777777', birthDate: '1985-12-01' },
            other.host,
          ).expect(404)
        ).body,
      ).toEqual(QR_INACTIVE);
      expect((await qrView('B'.repeat(43)).expect(404)).body).toEqual(
        QR_INACTIVE,
      );
      const altamiraQr = (
        (
          await as(
            api().post(`/api/v1/locations/${altamira}/check-in-settings/qr`),
            clinic.adminToken,
          ).expect(201)
        ).body as { token: string }
      ).token;
      await qrView(altamiraQr).expect(200);
      await as(
        api().post(`/api/v1/locations/${altamira}/check-in-settings/qr/revoke`),
        clinic.adminToken,
      ).expect(200);
      expect((await qrView(altamiraQr).expect(404)).body).toEqual(QR_INACTIVE);
    });

    // ISOLATION_COVERS: GET /locations/:locationId/check-in-settings
    // ISOLATION_COVERS: PATCH /locations/:locationId/check-in-settings
    // ISOLATION_COVERS: POST /locations/:locationId/check-in-settings/qr
    // ISOLATION_COVERS: POST /locations/:locationId/check-in-settings/qr/revoke
    it('aislamiento: la clínica B no ve ni toca los ajustes ni el QR de la sede de A (404) y los de A siguen igual', async () => {
      const before = await raw.locationCheckInSettings.findFirstOrThrow({
        where: { locationId: chacao },
      });
      const asB = (req: request.Test) =>
        as(req, other.adminToken, undefined, other.host);
      const base = `/api/v1/locations/${chacao}/check-in-settings`;
      await asB(api().get(base)).expect(404);
      await asB(api().patch(base)).send({ minutesBefore: 5 }).expect(404);
      await asB(api().post(`${base}/qr`)).expect(404);
      await asB(api().post(`${base}/qr/revoke`)).expect(404);
      const after = await raw.locationCheckInSettings.findFirstOrThrow({
        where: { locationId: chacao },
      });
      expect(after).toEqual(before);
      await qrView(qrChacao).expect(200);
    });

    it('bloqueo: el quinto fallo desde la misma IP en la sede da 429 durante 15 min, aunque luego acierte', async () => {
      // La sede ya acumula 4 fallos de la prueba anterior de esta IP.
      const res = await qrIdentify(qrChacao, {
        documentNumber: 'V-12121212',
        birthDate: '2000-01-01',
      }).expect(429);
      expect(res.body).toMatchObject({
        code: 'CHECK_IN_LOCKED',
        retryAfterSeconds: expect.any(Number) as number,
      });
      const patientId = await patient('Gabriel', 'V-13131313', '1992-02-02');
      const appt = await bookToday(patientId, chacao, 0);
      await qrIdentify(qrChacao, {
        documentNumber: 'V-13131313',
        birthDate: '1992-02-02',
      }).expect(429);
      expect(
        (await raw.appointment.findUniqueOrThrow({ where: { id: appt.id } }))
          .status,
      ).toBe('SCHEDULED');
      // Otra sede de la misma clínica no está bloqueada para esta IP.
      secondQr = (
        (
          await as(
            api().post(`/api/v1/locations/${altamira}/check-in-settings/qr`),
            clinic.adminToken,
          ).expect(201)
        ).body as { token: string }
      ).token;
      await qrIdentify(secondQr, {
        documentNumber: 'V-13131313',
        birthDate: '1992-02-02',
      }).expect(400);
    });

    it('acertar con los datos propios no rehabilita los intentos: el siguiente fallo de esa IP es el quinto y bloquea', async () => {
      const ip = '203.0.113.71';
      const own = await patient('Andrés', 'V-31313131', '1988-08-08');
      await bookToday(own, altamira, 0);
      for (let i = 0; i < 4; i++) {
        await qrIdentify(
          secondQr,
          { documentNumber: `V-4040404${i}`, birthDate: '1970-01-01' },
          clinic.host,
          ip,
        ).expect(400);
      }
      await qrIdentify(
        secondQr,
        { documentNumber: 'V-31313131', birthDate: '1988-08-08' },
        clinic.host,
        ip,
      ).expect(200);
      const res = await qrIdentify(
        secondQr,
        { documentNumber: 'V-40404049', birthDate: '1970-01-01' },
        clinic.host,
        ip,
      ).expect(429);
      expect(res.body).toMatchObject({ code: 'CHECK_IN_LOCKED' });
    });

    it('bloqueo por documento: rotar de IP contra un mismo paciente bloquea al quinto fallo, también su intento bueno', async () => {
      const target = await patient('Beatriz', 'V-24242424', '1979-03-03');
      const appt = await bookToday(target, altamira, 0);
      for (let i = 0; i < 4; i++) {
        await qrIdentify(
          secondQr,
          { documentNumber: 'V-24242424', birthDate: `1979-03-1${i}` },
          clinic.host,
          `198.51.100.${10 + i}`,
        ).expect(400);
      }
      // Quinto fallo, sin la letra (cuenta igual): bloquea el documento.
      await qrIdentify(
        secondQr,
        { documentNumber: '24242424', birthDate: '1979-03-19' },
        clinic.host,
        '198.51.100.20',
      ).expect(429);
      // Desde otra IP y con los datos buenos: sigue bloqueado.
      await qrIdentify(
        secondQr,
        { documentNumber: 'V-24242424', birthDate: '1979-03-03' },
        clinic.host,
        '198.51.100.21',
      ).expect(429);
      expect(
        (await raw.appointment.findUniqueOrThrow({ where: { id: appt.id } }))
          .status,
      ).toBe('SCHEDULED');
      // Otro documento desde esa IP no está bloqueado (misma respuesta de siempre).
      expect(
        (
          await qrIdentify(
            secondQr,
            { documentNumber: 'V-50505050', birthDate: '1990-01-01' },
            clinic.host,
            '198.51.100.21',
          ).expect(400)
        ).body,
      ).toEqual(NO_MATCH);
    });
  });
});
