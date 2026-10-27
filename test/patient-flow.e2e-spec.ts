import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationBody,
} from './support/location-fixtures';

// DX-200 en HTTP real: flujo del paciente en la clínica. Recepción marca
// «Llegó», el odontólogo «En sillón» y «Listo para cobrar», recepción la
// completa; «Deshacer llegada»; permisos por rol; el panel «En clínica» por
// sede (la otra sede y la otra clínica no se ven; el odontólogo solo ve a sus
// pacientes); y todo queda en auditoría.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const MIN = 60_000;
const TZ = 'America/Bogota';

/** Hoy en Bogotá (YYYY-MM-DD). */
function bogotaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

/** Instante de una hora de pared de hoy en Bogotá (UTC−5 fijo). */
function bogotaAt(hhmm: string): Date {
  return new Date(`${bogotaToday()}T${hhmm}:00-05:00`);
}

interface Member {
  userId: string;
  token: string;
}
interface AppointmentBody {
  id: string;
  status: string;
  arrivedAt: string | null;
  seatedAt: string | null;
  readyForCheckoutAt: string | null;
}
interface InClinicBody {
  date: string;
  timeZone: string;
  scope: string;
  waiting: Record<string, unknown>[];
  inChair: Record<string, unknown>[];
  readyForCheckout: Record<string, unknown>[];
}

describe('Flujo del paciente en la clínica (e2e, DX-200)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let dentist: Member;
  let reception: Member;
  let assistant: Member;
  let mainId: string;
  let northId: string;
  let otherLocationId: string;
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

  async function member(role: ClinicRole): Promise<Member> {
    const m = await seedMember(raw, clinic, role);
    return {
      userId: m.userId,
      token: await loginAs(app, clinic.host, m.email),
    };
  }

  async function patient(c: Clinic, firstName: string): Promise<string> {
    const res = await as(
      api().post('/api/v1/patients'),
      c.adminToken,
      undefined,
      c.host,
    )
      .send({
        firstName,
        lastName: 'Flujo',
        docType: 'CC',
        docNumber: `200${++patientN}`,
        sex: 'F',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function book(
    firstName: string,
    locationId: string,
    offsetMinutes: number,
    providerId = dentist.userId,
    reason = 'Endodoncia molar 36',
  ): Promise<AppointmentBody> {
    const patientId = await patient(clinic, firstName);
    // Se agenda por la API en el futuro (pasado mañana a la misma hora de
    // pared, sin cruzar la medianoche ni solaparse) y se trae a HOY por `raw`: así el spec no depende de la hora a la que corra
    // (agendar en el pasado no se puede, y la llegada solo vale hoy).
    const later = new Date(
      bogotaAt('00:00').getTime() + 2 * 24 * 60 * MIN + offsetMinutes * MIN,
    );
    const res = await as(
      api().post('/api/v1/appointments'),
      reception.token,
      locationId,
    )
      .send({
        patientId,
        providerId,
        start: later.toISOString(),
        end: new Date(later.getTime() + 10 * MIN).toISOString(),
        reason,
      })
      .expect(201);
    const id = (res.body as AppointmentBody).id;
    const today = new Date(bogotaAt('00:00').getTime() + offsetMinutes * MIN);
    await raw.appointment.update({
      where: { id },
      data: { start: today, end: new Date(today.getTime() + 10 * MIN) },
    });
    return { ...(res.body as AppointmentBody), id };
  }

  const setStatus = (id: string, status: string, token: string) =>
    as(api().patch(`/api/v1/appointments/${id}`), token).send({ status });

  const panel = (
    token: string,
    locationId: string | undefined,
    host?: string,
  ) => as(api().get('/api/v1/appointments/in-clinic'), token, locationId, host);

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx200-e2e');
    other = await registerClinic(app, 'dx200-e2e-otra');
    dentist = await member(ClinicRole.DENTIST);
    reception = await member(ClinicRole.RECEPTION);
    assistant = await member(ClinicRole.ASSISTANT);

    const locations = await as(
      api().get('/api/v1/locations'),
      clinic.adminToken,
    ).expect(200);
    mainId = (locations.body as { id: string }[])[0].id;
    const north = await as(api().post('/api/v1/locations'), clinic.adminToken)
      .send(locationBody(REGIONAL_BOGOTA_FIXTURE, { name: 'Sede Norte' }))
      .expect(201);
    northId = (north.body as { id: string }).id;
    const otherLocations = await as(
      api().get('/api/v1/locations'),
      other.adminToken,
      undefined,
      other.host,
    ).expect(200);
    otherLocationId = (otherLocations.body as { id: string }[])[0].id;
    // Horario abierto todo el día en ambas sedes: el spec agenda «hoy» a la
    // hora que corra.
    for (const locationId of [mainId, northId]) {
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
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('llegó → en sillón → listo para cobrar → completada, con horas y auditoría', async () => {
    const appt = await book('Ana', mainId, 8 * 60);

    const arrived = await setStatus(appt.id, 'ARRIVED', reception.token).expect(
      200,
    );
    expect(arrived.body).toMatchObject({ status: 'ARRIVED', seatedAt: null });
    expect((arrived.body as AppointmentBody).arrivedAt).not.toBeNull();

    // El odontólogo no marca llegadas; recepción no sienta.
    await setStatus(appt.id, 'IN_CHAIR', reception.token).expect(403);

    const seated = await setStatus(appt.id, 'IN_CHAIR', dentist.token).expect(
      200,
    );
    expect((seated.body as AppointmentBody).seatedAt).not.toBeNull();
    // Desde el sillón no hay no-show ni cancelación.
    const noShow = await setStatus(
      appt.id,
      'NO_SHOW',
      clinic.adminToken,
    ).expect(409);
    expect((noShow.body as { message: string }).message).toMatch(
      /no es una inasistencia/,
    );
    await setStatus(appt.id, 'CANCELLED', clinic.adminToken).expect(409);

    await setStatus(appt.id, 'READY_FOR_CHECKOUT', dentist.token).expect(200);
    // La salida es de recepción.
    await setStatus(appt.id, 'COMPLETED', dentist.token).expect(403);
    const done = await setStatus(appt.id, 'COMPLETED', reception.token).expect(
      200,
    );
    expect(done.body).toMatchObject({ status: 'COMPLETED' });
    const body = done.body as AppointmentBody;
    expect([
      body.arrivedAt,
      body.seatedAt,
      body.readyForCheckoutAt,
    ]).not.toContain(null);

    // Un evento por paso (el orden por hora puede empatar en el mismo ms).
    const events = await raw.auditEvent.findMany({
      where: { tenantId: clinic.tenantId, resourceId: appt.id },
      select: { metadata: true, actorRole: true },
    });
    expect(
      events.filter(
        (e) =>
          (e.metadata as { reason?: string }).reason ===
          'APPOINTMENT_PLAN_ITEMS',
      ),
    ).toHaveLength(0);
    // Una traza HTTP por escritura sigue existiendo, separada del dominio.
    expect(
      events.filter((e) => !(e.metadata as { reason?: string }).reason),
    ).toHaveLength(5);
    const flowEvents = events.filter(
      (e) => (e.metadata as { reason?: string }).reason === 'PATIENT_FLOW',
    );
    expect(
      flowEvents.map((e) => ({
        role: e.actorRole,
        status: (e.metadata as { status?: unknown }).status,
      })),
    ).toEqual(
      expect.arrayContaining([
        { role: 'RECEPTION', status: { from: 'SCHEDULED', to: 'ARRIVED' } },
        { role: 'DENTIST', status: { from: 'ARRIVED', to: 'IN_CHAIR' } },
        {
          role: 'DENTIST',
          status: { from: 'IN_CHAIR', to: 'READY_FOR_CHECKOUT' },
        },
        {
          role: 'RECEPTION',
          status: { from: 'READY_FOR_CHECKOUT', to: 'COMPLETED' },
        },
      ]),
    );
    expect(flowEvents).toHaveLength(4);
  });

  it('sin saltos: de agendada a «En sillón» es 409; la llegada de otro día también', async () => {
    const appt = await book('Berta', mainId, 8 * 60 + 15);
    await setStatus(appt.id, 'IN_CHAIR', clinic.adminToken).expect(409);

    const patientId = await patient(clinic, 'Carla');
    const later = new Date(bogotaAt('12:00').getTime() + 3 * 24 * 60 * MIN);
    const future = await as(
      api().post('/api/v1/appointments'),
      reception.token,
      mainId,
    )
      .send({
        patientId,
        providerId: dentist.userId,
        start: later.toISOString(),
        end: new Date(later.getTime() + 10 * MIN).toISOString(),
      })
      .expect(201);
    const res = await setStatus(
      (future.body as AppointmentBody).id,
      'ARRIVED',
      reception.token,
    ).expect(409);
    expect((res.body as { message: string }).message).toMatch(/día de la cita/);
  });

  it('«Deshacer llegada» vuelve al estado anterior, borra la hora y queda en auditoría', async () => {
    const appt = await book('Dora', mainId, 8 * 60 + 30);
    await setStatus(appt.id, 'CONFIRMED', reception.token).expect(200);
    await setStatus(appt.id, 'ARRIVED', assistant.token).expect(200);

    await as(
      api().post(`/api/v1/appointments/${appt.id}/undo-arrival`),
      dentist.token,
    ).expect(403);
    const undone = await as(
      api().post(`/api/v1/appointments/${appt.id}/undo-arrival`),
      reception.token,
    ).expect(200);
    expect(undone.body).toMatchObject({ status: 'CONFIRMED', arrivedAt: null });
    await as(
      api().post(`/api/v1/appointments/${appt.id}/undo-arrival`),
      reception.token,
    ).expect(409);

    const events = await raw.auditEvent.findMany({
      where: { tenantId: clinic.tenantId, resourceId: appt.id },
      select: { metadata: true, actorRole: true },
    });
    expect(events).toContainEqual({
      actorRole: 'RECEPTION',
      metadata: {
        reason: 'ARRIVAL_UNDONE',
        status: { from: 'ARRIVED', to: 'CONFIRMED' },
      },
    });
  });

  it('el panel «En clínica» es por sede, sin datos clínicos; el odontólogo ve solo lo suyo', async () => {
    const waiting = await book('Elena', mainId, 9 * 60);
    const seated = await book('Fani', mainId, 9 * 60 + 15, clinic.adminUserId);
    const north = await book('Gabi', northId, 9 * 60 + 30);
    await setStatus(waiting.id, 'ARRIVED', reception.token).expect(200);
    await setStatus(seated.id, 'ARRIVED', reception.token).expect(200);
    await setStatus(seated.id, 'IN_CHAIR', clinic.adminToken).expect(200);
    await setStatus(north.id, 'ARRIVED', reception.token).expect(200);

    const view = await panel(reception.token, mainId).expect(200);
    const body = view.body as InClinicBody;
    expect(body).toMatchObject({
      date: bogotaToday(),
      timeZone: TZ,
      scope: 'LOCATION',
    });
    expect(body.waiting.map((i) => i.appointmentId)).toEqual([waiting.id]);
    expect(body.inChair.map((i) => i.appointmentId)).toEqual([seated.id]);
    // Elena tenía cita a las 09:00 y llegó «ahora» (a la hora que corra).
    const late = Date.now() - bogotaAt('09:00').getTime();
    expect(body.waiting[0]).toMatchObject({
      patientFirstName: 'Elena',
      providerName: 'Miembro DENTIST',
      punctuality:
        late <= 0 ? 'ON_TIME' : late <= 5 * MIN ? 'LATE' : 'VERY_LATE',
      minutesInStatus: 0,
    });
    expect(body.waiting[0]).not.toHaveProperty('reason');
    expect(JSON.stringify(body)).not.toMatch(/Endodoncia/);

    const northView = await panel(assistant.token, northId).expect(200);
    expect(
      (northView.body as InClinicBody).waiting.map((i) => i.appointmentId),
    ).toEqual([north.id]);

    // El odontólogo: solo sus pacientes (la del sillón es de la titular).
    const mine = await panel(dentist.token, mainId).expect(200);
    expect(mine.body).toMatchObject({ scope: 'MINE' });
    expect(
      (mine.body as InClinicBody).waiting.map((i) => i.appointmentId),
    ).toEqual([waiting.id]);
    expect((mine.body as InClinicBody).inChair).toEqual([]);

    // Sin sede, 400; con la sede de otra clínica, 400; la otra clínica en la
    // suya no ve nada de esta.
    const noLocation = await panel(reception.token, undefined).expect(400);
    expect((noLocation.body as { message: string }).message).toMatch(
      /Elige una sede/,
    );
    await panel(reception.token, otherLocationId).expect(400);
    const otherView = await panel(
      other.adminToken,
      otherLocationId,
      other.host,
    ).expect(200);
    expect(otherView.body).toMatchObject({
      waiting: [],
      inChair: [],
      readyForCheckout: [],
    });
  });

  it('un paciente en la clínica no se puede archivar (su cita está en curso)', async () => {
    const appt = await book('Hilda', mainId, 10 * 60);
    const { patientId } = (
      await as(
        api().get(`/api/v1/appointments/${appt.id}`),
        reception.token,
      ).expect(200)
    ).body as { patientId: string };
    await setStatus(appt.id, 'ARRIVED', reception.token).expect(200);
    await as(
      api().delete(`/api/v1/patients/${patientId}`),
      clinic.adminToken,
    ).expect(409);
  });
});
