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
  locationBody,
  type RegionalFixture,
} from './support/location-fixtures';
import { SCHEDULE_BLOCK_CLOCK } from '../src/modules/schedule-blocks/application/schedule-block-clock';
import {
  addCivilDays,
  civilDateIn,
  civilWeekday,
  zonedWallTime,
} from '../src/shared/time/civil-day';

// DX-470 en HTTP real: «Atender sin cita». Con el reloj de la agenda fijado a
// un martes a las 10:00 de Caracas: paciente nuevo y existente, hueco
// reservado «Urgencias» 15:00–15:30, sobrecupo con motivo cuando no queda,
// validación de las 6 señales y la nota, roles, sedes permitidas, duplicado
// por documento, otra clínica, hora del servidor y el panel «En clínica» con
// la insignia y las señales (la agenda, no).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const CARACAS: RegionalFixture = {
  country: 'VE',
  currency: 'VES',
  timeZone: 'America/Caracas',
  locale: 'es-VE',
  hourCycle: 'h23',
  defaultPhoneRegion: 'VE',
};

function nextTuesdayIn(zone: string): string {
  let day = addCivilDays(civilDateIn(new Date(), zone), 7);
  while (civilWeekday(day) !== 2) day = addCivilDays(day, 1);
  return day;
}
const DAY = nextTuesdayIn(CARACAS.timeZone);
const local = (hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number);
  return zonedWallTime(DAY, h * 60 + m, CARACAS.timeZone);
};

let clockNow = new Date(0);

interface Body {
  id: string;
  [key: string]: unknown;
}
interface Member {
  userId: string;
  email: string;
  token: string;
}
interface InClinicItem {
  appointmentId: string;
  urgent: boolean;
  walkIn: boolean;
  overbooked: boolean;
  triageFlags: string[];
  triageNote: string | null;
}

describe('«Atender sin cita» (e2e, DX-470)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let reception: Member;
  let assistant: Member;
  let dentist: Member;
  let mainId: string;
  let northId: string;
  let urgentTypeId: string;
  let existingPatientId: string;
  let otherPatientId: string;
  let otherTypeId: string;
  let firstWalkInId: string;

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
  const walkIn = (
    token: string,
    body: Record<string, unknown>,
    locationId: string | undefined = mainId,
    host = clinic.host,
  ) =>
    as(
      api().post('/api/v1/appointments/walk-in'),
      token,
      locationId,
      host,
    ).send(body);

  async function member(c: Clinic, role: ClinicRole): Promise<Member> {
    const m = await seedMember(raw, c, role);
    return { ...m, token: await loginAs(app, c.host, m.email) };
  }

  async function createPatient(c: Clinic, doc: string, firstName: string) {
    const res = await as(
      api().post('/api/v1/patients'),
      c.adminToken,
      undefined,
      c.host,
    )
      .send({
        firstName,
        lastName: 'Urgencia',
        docType: 'NATIONAL_ID',
        docNumber: doc,
        sex: 'F',
      })
      .expect(201);
    return (res.body as Body).id;
  }

  async function createUrgentType(c: Clinic): Promise<string> {
    const res = await as(
      api().post('/api/v1/appointment-types'),
      c.adminToken,
      undefined,
      c.host,
    )
      .send({
        name: 'Consulta de urgencia',
        durationMinutes: 30,
        color: '#DC2626',
        isUrgent: true,
      })
      .expect(201);
    return (res.body as Body).id;
  }

  async function inClinic(
    token: string,
    locationId = mainId,
  ): Promise<InClinicItem[]> {
    const res = await as(
      api().get(`/api/v1/appointments/in-clinic?date=${DAY}`),
      token,
      locationId,
    ).expect(200);
    return (res.body as { waiting: InClinicItem[] }).waiting;
  }

  beforeAll(async () => {
    app = await createE2eApp((builder) => {
      builder.overrideProvider(SCHEDULE_BLOCK_CLOCK).useValue(() => clockNow);
    });
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx470-caracas', CARACAS);
    other = await registerClinic(app, 'dx470-otra', CARACAS);
    reception = await member(clinic, ClinicRole.RECEPTION);
    assistant = await member(clinic, ClinicRole.ASSISTANT);
    dentist = await member(clinic, ClinicRole.DENTIST);
    const sedes = await as(
      api().get('/api/v1/locations'),
      clinic.adminToken,
    ).expect(200);
    mainId = (sedes.body as Body[])[0].id;
    const north = await as(api().post('/api/v1/locations'), clinic.adminToken)
      .send(locationBody(CARACAS, { name: 'Sede Norte' }))
      .expect(201);
    northId = (north.body as Body).id;
    urgentTypeId = await createUrgentType(clinic);
    otherTypeId = await createUrgentType(other);
    existingPatientId = await createPatient(clinic, '470001', 'Berta');
    otherPatientId = await createPatient(other, '470901', 'Olga');
    clockNow = local('10:00');
    await as(api().post('/api/v1/schedule-blocks'), reception.token)
      .send({
        providerId: dentist.userId,
        locationId: mainId,
        start: local('15:00').toISOString(),
        end: local('15:30').toISOString(),
        kind: 'RESERVED',
        reservedForTypeIds: [urgentTypeId],
        note: 'Urgencias',
      })
      .expect(201);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('paciente nuevo: alta + cita ARRIVED urgente en el hueco reservado, en un paso', async () => {
    const patientsBefore = await raw.patient.count({
      where: { tenantId: clinic.tenantId },
    });
    const res = await walkIn(reception.token, {
      newPatient: {
        firstName: 'Lucía',
        lastName: 'Sin Cita',
        phone: '+58 412 555 0101',
      },
      providerId: dentist.userId,
      triageFlags: ['PAIN', 'SWELLING'],
      triageNote: 'Muela 36, dolor nocturno',
      // Lo que el cliente no decide: se ignora.
      start: local('08:00').toISOString(),
      arrivedAt: local('08:00').toISOString(),
      locationId: northId,
      createdById: dentist.userId,
    }).expect(201);
    const body = res.body as Body & Record<string, unknown>;
    firstWalkInId = body.id;
    expect(body).toMatchObject({
      status: 'ARRIVED',
      walkIn: true,
      overbooked: false,
      patientCreated: true,
      overbookId: null,
      appointmentTypeId: urgentTypeId,
      locationId: mainId,
      providerId: dentist.userId,
      createdById: reception.userId,
      start: local('15:00').toISOString(),
      end: local('15:30').toISOString(),
      arrivedAt: local('10:00').toISOString(),
      triageFlags: ['PAIN', 'SWELLING'],
      triageNote: 'Muela 36, dolor nocturno',
      patientFirstName: 'Lucía',
    });
    expect(
      await raw.patient.count({ where: { tenantId: clinic.tenantId } }),
    ).toBe(patientsBefore + 1);

    // «En clínica»: con su insignia y sus señales.
    const waiting = await inClinic(reception.token);
    expect(
      waiting.find((i) => i.appointmentId === firstWalkInId),
    ).toMatchObject({
      urgent: true,
      walkIn: true,
      triageFlags: ['PAIN', 'SWELLING'],
      triageNote: 'Muela 36, dolor nocturno',
    });

    // La agenda (GET /appointments) no lleva el triaje; la cita, sí.
    const list = await as(
      api().get(
        `/api/v1/appointments?from=${encodeURIComponent(local('00:00').toISOString())}&to=${encodeURIComponent(local('23:59').toISOString())}`,
      ),
      reception.token,
      mainId,
    ).expect(200);
    const row = (list.body as Body[]).find((a) => a.id === firstWalkInId)!;
    expect(row).toMatchObject({ walkIn: true });
    expect(row).not.toHaveProperty('triageFlags');
    expect(row).not.toHaveProperty('triageNote');
    const detail = await as(
      api().get(`/api/v1/appointments/${firstWalkInId}`),
      reception.token,
    ).expect(200);
    expect(detail.body).toMatchObject({ triageFlags: ['PAIN', 'SWELLING'] });

    // Auditoría sin el triaje.
    const events = await raw.auditEvent.findMany({
      where: { tenantId: clinic.tenantId, resourceId: firstWalkInId },
    });
    expect(JSON.stringify(events.map((e) => e.metadata))).not.toMatch(
      /Muela|nocturno|SWELLING/,
    );
  });

  it('sin hueco reservado libre: 409 que ofrece el sobrecupo; con motivo, anotado y ahora', async () => {
    const full = await walkIn(reception.token, {
      patientId: existingPatientId,
      providerId: dentist.userId,
      triageFlags: ['BLEEDING'],
    }).expect(409);
    expect(full.body).toMatchObject({
      code: 'NO_RESERVED_SLOT',
      canOverbook: true,
      message:
        'No queda ningún hueco reservado libre hoy para este profesional. Puedes atenderlo en sobrecupo indicando el motivo.',
    });

    const res = await walkIn(assistant.token, {
      patientId: existingPatientId,
      providerId: dentist.userId,
      triageFlags: ['BLEEDING'],
      overbookReason: 'Sangrado tras extracción',
    }).expect(201);
    const body = res.body as Body & { overbookId: string };
    expect(body).toMatchObject({
      overbooked: true,
      patientCreated: false,
      start: local('10:00').toISOString(),
      end: local('10:30').toISOString(),
    });
    const override = await raw.appointmentReservedOverride.findUniqueOrThrow({
      where: { id: body.overbookId },
    });
    expect(override).toMatchObject({
      kind: 'WALK_IN_OVERBOOK',
      reason: 'Sangrado tras extracción',
      appointmentId: body.id,
    });
    const waiting = await inClinic(reception.token);
    expect(waiting.find((i) => i.appointmentId === body.id)).toMatchObject({
      overbooked: true,
      urgent: true,
    });
  });

  it('las señales solo aceptan los 6 valores y la nota ≤ 200 (400 sin escribir)', async () => {
    const before = await raw.appointment.count({
      where: { tenantId: clinic.tenantId },
    });
    const bad = await walkIn(reception.token, {
      patientId: existingPatientId,
      providerId: dentist.userId,
      triageFlags: ['PAIN', 'ITCH'],
      overbookReason: 'Dolor agudo',
    }).expect(400);
    expect(JSON.stringify(bad.body)).toContain(
      'Las señales de triaje deben ser de',
    );
    await walkIn(reception.token, {
      patientId: existingPatientId,
      providerId: dentist.userId,
      triageNote: 'x'.repeat(201),
      overbookReason: 'Dolor agudo',
    }).expect(400);
    await walkIn(reception.token, {
      patientId: existingPatientId,
      newPatient: { firstName: 'A', lastName: 'B', phone: '+58 412 555 0102' },
      providerId: dentist.userId,
    }).expect(400);
    await walkIn(reception.token, { providerId: dentist.userId }).expect(400);
    expect(
      await raw.appointment.count({ where: { tenantId: clinic.tenantId } }),
    ).toBe(before);
  });

  it('alta mínima con un documento que ya existe: 409 PATIENT_DUPLICATE con su id, sin crear nada', async () => {
    const patients = await raw.patient.count({
      where: { tenantId: clinic.tenantId },
    });
    const res = await walkIn(reception.token, {
      newPatient: {
        firstName: 'Berta',
        lastName: 'Repetida',
        phone: '+58 412 555 0103',
        docType: 'NATIONAL_ID',
        docNumber: '470.001',
      },
      providerId: dentist.userId,
      overbookReason: 'Dolor agudo',
    }).expect(409);
    expect(res.body).toMatchObject({
      code: 'PATIENT_DUPLICATE',
      existingPatientId,
      existingPatient: {
        id: existingPatientId,
        firstName: 'Berta',
        lastName: 'Urgencia',
      },
    });
    expect(
      await raw.patient.count({ where: { tenantId: clinic.tenantId } }),
    ).toBe(patients);
  });

  it('documento repetido sin hueco reservado: el duplicado sale ANTES que el sobrecupo', async () => {
    const patients = await raw.patient.count({
      where: { tenantId: clinic.tenantId },
    });
    // El reservado de las 15:00 ya lo ocupó la primera llegada: sin motivo,
    // antes daba NO_RESERVED_SLOT y el duplicado solo tras escribirlo.
    const res = await walkIn(reception.token, {
      newPatient: {
        firstName: 'Berta',
        lastName: 'Tecleada',
        phone: '+58 412 555 0104',
        docNumber: '470001',
      },
      providerId: dentist.userId,
    }).expect(409);
    expect(res.body).toMatchObject({
      code: 'PATIENT_DUPLICATE',
      existingPatientId,
      existingPatient: {
        id: existingPatientId,
        firstName: 'Berta',
        lastName: 'Urgencia',
      },
    });
    expect(res.body).not.toHaveProperty('canOverbook');
    expect(
      await raw.patient.count({ where: { tenantId: clinic.tenantId } }),
    ).toBe(patients);
  });

  it('roles: el odontólogo no marca llegadas (403)', async () => {
    const res = await walkIn(dentist.token, {
      patientId: existingPatientId,
      providerId: dentist.userId,
      overbookReason: 'Dolor agudo',
    }).expect(403);
    expect((res.body as { message: string }).message).toBe(
      '«Atender sin cita» lo usan recepción, la asistente o la administración.',
    );
  });

  it('sedes: una no permitida da 403 y un profesional que no atiende allí, 400', async () => {
    // La asistente queda solo en la Sede Norte (surte efecto al volver a entrar).
    const restricted = assistant;
    await as(
      api().put(`/api/v1/staff/${restricted.userId}/locations`),
      clinic.adminToken,
    )
      .send({ locationIds: [northId] })
      .expect(200);
    const token = await loginAs(app, clinic.host, restricted.email);
    const res = await walkIn(token, {
      patientId: existingPatientId,
      providerId: dentist.userId,
      overbookReason: 'Dolor agudo',
    }).expect(403);
    expect(res.body).toMatchObject({ code: 'LOCATION_NOT_ALLOWED' });

    await as(
      api().put(`/api/v1/staff/${dentist.userId}/locations`),
      clinic.adminToken,
    )
      .send({ locationIds: [mainId] })
      .expect(200);
    const notThere = await walkIn(
      reception.token,
      {
        patientId: existingPatientId,
        providerId: dentist.userId,
        overbookReason: 'Dolor agudo',
      },
      northId,
    ).expect(400);
    expect((notThere.body as { message: string }).message).toBe(
      'Algún profesional no atiende en esta sede.',
    );
  });

  it('ids de otra clínica: paciente y profesional 404, tipo 400; nada de la otra clínica cambia', async () => {
    await walkIn(reception.token, {
      patientId: otherPatientId,
      providerId: dentist.userId,
      overbookReason: 'Dolor agudo',
    }).expect(404);
    await walkIn(reception.token, {
      patientId: existingPatientId,
      providerId: other.adminUserId,
      overbookReason: 'Dolor agudo',
    }).expect(404);
    const type = await walkIn(reception.token, {
      patientId: existingPatientId,
      providerId: dentist.userId,
      appointmentTypeId: otherTypeId,
      overbookReason: 'Dolor agudo',
    }).expect(400);
    expect((type.body as { message: string }).message).toBe(
      'El tipo de cita elegido no es de urgencia o está desactivado.',
    );
    expect(
      await raw.appointment.count({ where: { tenantId: other.tenantId } }),
    ).toBe(0);
    // Y la otra clínica no ve el panel de esta.
    const otherSedes = await as(
      api().get('/api/v1/locations'),
      other.adminToken,
      undefined,
      other.host,
    ).expect(200);
    const otherMain = (otherSedes.body as Body[])[0].id;
    const res = await as(
      api().get(`/api/v1/appointments/in-clinic?date=${DAY}`),
      other.adminToken,
      otherMain,
      other.host,
    ).expect(200);
    expect((res.body as { waiting: unknown[] }).waiting).toEqual([]);
  });
});
