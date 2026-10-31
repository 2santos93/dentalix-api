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
  STAFF_CANCELLATION,
} from './support/e2e-fixtures';
import type { RegionalFixture } from './support/location-fixtures';
import { SCHEDULE_BLOCK_CLOCK } from '../src/modules/schedule-blocks/application/schedule-block-clock';
import {
  addCivilDays,
  civilDateIn,
  civilWeekday,
  zonedWallTime,
} from '../src/shared/time/civil-day';

// DX-446 en HTTP real: huecos reservados para urgencias. Un bloque RESERVED
// «Urgencias» 15:00–15:30 deja agendar «Consulta de urgencia» y rechaza
// «Limpieza» con 409 en español, salvo pasada la liberación (11:00 en la hora
// de la sede: Caracas y Madrid, con el reloj de la agenda INYECTADO) o con
// override (ADMIN/odontólogo con motivo, auditado; recepción 403). Tipos de
// otra clínica: 404.
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
const MADRID: RegionalFixture = {
  country: 'ES',
  currency: 'EUR',
  timeZone: 'Europe/Madrid',
  locale: 'es-ES',
  hourCycle: 'h23',
  defaultPhoneRegion: 'ES',
};

/** Primer martes a 7 días o más en la zona: siempre futuro para la API. */
function nextTuesdayIn(zone: string): string {
  let day = addCivilDays(civilDateIn(new Date(), zone), 7);
  while (civilWeekday(day) !== 2) day = addCivilDays(day, 1);
  return day;
}
const at = (day: string, hhmm: string, zone: string): Date => {
  const [h, m] = hhmm.split(':').map(Number);
  return zonedWallTime(day, h * 60 + m, zone);
};

/** El reloj de la agenda que ve la API (solo decide la liberación). */
let clockNow = new Date(0);

interface Body {
  id: string;
  [key: string]: unknown;
}
interface Member {
  userId: string;
  token: string;
}
interface BlockListItem extends Body {
  kind: string;
  reservedForTypeIds: string[];
  reservedForTypes: { id: string; name: string; isUrgent: boolean }[];
  releaseAtMinute: number | null;
  releaseAt: string | null;
  released: boolean;
}

const RESERVED_MESSAGE =
  'Ese horario está reservado para urgencias (Consulta de urgencia). Elige otro hueco o usa un tipo permitido.';

describe('Huecos reservados para urgencias (e2e, DX-446)', () => {
  let app: INestApplication<App>;
  let caracas: Clinic;
  let madrid: Clinic;
  let dentist: Member;
  let reception: Member;
  let assistant: Member;
  let locationId: string;
  let madridLocationId: string;
  let urgentTypeId: string;
  let cleaningTypeId: string;
  let madridUrgentTypeId: string;
  let madridCleaningTypeId: string;
  let blockId: string;
  const patients: string[] = [];
  let madridPatientId: string;

  const DAY = nextTuesdayIn(CARACAS.timeZone);
  const MADRID_DAY = nextTuesdayIn(MADRID.timeZone);
  const local = (hhmm: string) => at(DAY, hhmm, CARACAS.timeZone);

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = caracas.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  async function member(role: ClinicRole): Promise<Member> {
    const m = await seedMember(raw, caracas, role);
    return {
      userId: m.userId,
      token: await loginAs(app, caracas.host, m.email),
    };
  }

  async function createPatient(c: Clinic, doc: string, firstName: string) {
    const res = await as(api().post('/api/v1/patients'), c.adminToken, c.host)
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

  async function createType(
    c: Clinic,
    name: string,
    color: string,
    isUrgent?: boolean,
  ): Promise<Body> {
    const res = await as(
      api().post('/api/v1/appointment-types'),
      c.adminToken,
      c.host,
    )
      .send({ name, durationMinutes: 30, color, isUrgent })
      .expect(201);
    return res.body as Body;
  }

  async function firstLocation(c: Clinic): Promise<string> {
    const res = await as(
      api().get('/api/v1/locations'),
      c.adminToken,
      c.host,
    ).expect(200);
    return (res.body as Body[])[0].id;
  }

  async function weekdaySchedule(c: Clinic): Promise<void> {
    await as(api().put('/api/v1/locations/schedule'), c.adminToken, c.host)
      .send({
        ranges: [1, 2, 3, 4, 5].map((weekday) => ({
          weekday,
          startMinute: 8 * 60,
          endMinute: 19 * 60,
        })),
      })
      .expect(200);
  }

  function book(
    token: string,
    body: {
      patientId: string;
      providerId: string;
      start: Date;
      appointmentTypeId: string;
      overrideReason?: string;
    },
    host = caracas.host,
  ) {
    return as(api().post('/api/v1/appointments'), token, host).send({
      ...body,
      start: body.start.toISOString(),
    });
  }

  function cancel(id: string, token = caracas.adminToken, host = caracas.host) {
    return as(api().patch(`/api/v1/appointments/${id}`), token, host)
      .send({ status: 'CANCELLED', ...STAFF_CANCELLATION })
      .expect(200);
  }

  async function listBlocks(
    token: string,
    day = DAY,
    zone = CARACAS.timeZone,
    host = caracas.host,
  ): Promise<BlockListItem[]> {
    const from = at(day, '00:00', zone).toISOString();
    const to = at(addCivilDays(day, 1), '00:00', zone).toISOString();
    const res = await as(
      api().get(
        `/api/v1/schedule-blocks?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ),
      token,
      host,
    ).expect(200);
    return res.body as BlockListItem[];
  }

  beforeAll(async () => {
    app = await createE2eApp((builder) => {
      builder.overrideProvider(SCHEDULE_BLOCK_CLOCK).useValue(() => clockNow);
    });
    await resetDatabase(raw);
    caracas = await registerClinic(app, 'dx446-caracas', CARACAS);
    madrid = await registerClinic(app, 'dx446-madrid', MADRID);
    dentist = await member(ClinicRole.DENTIST);
    reception = await member(ClinicRole.RECEPTION);
    assistant = await member(ClinicRole.ASSISTANT);
    await weekdaySchedule(caracas);
    await weekdaySchedule(madrid);
    locationId = await firstLocation(caracas);
    madridLocationId = await firstLocation(madrid);
    urgentTypeId = (
      await createType(caracas, 'Consulta de urgencia', '#DC2626', true)
    ).id;
    cleaningTypeId = (await createType(caracas, 'Limpieza', '#0EA5E9')).id;
    madridUrgentTypeId = (
      await createType(madrid, 'Consulta de urgencia', '#DC2626', true)
    ).id;
    madridCleaningTypeId = (await createType(madrid, 'Limpieza', '#0EA5E9')).id;
    patients.push(await createPatient(caracas, '446001', 'Ana'));
    patients.push(await createPatient(caracas, '446002', 'Berta'));
    patients.push(await createPatient(caracas, '446003', 'Carla'));
    madridPatientId = await createPatient(madrid, '446901', 'Marta');
    clockNow = local('10:59');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('tipos de cita: «Urgencia» se marca al crear y se edita (ADMIN)', async () => {
    const types = await as(
      api().get('/api/v1/appointment-types'),
      reception.token,
    ).expect(200);
    expect(
      (types.body as { name: string; isUrgent: boolean }[]).map((t) => [
        t.name,
        t.isUrgent,
      ]),
    ).toEqual([
      ['Consulta de urgencia', true],
      ['Limpieza', false],
    ]);
    const patched = await as(
      api().patch(`/api/v1/appointment-types/${cleaningTypeId}`),
      caracas.adminToken,
    )
      .send({ isUrgent: true })
      .expect(200);
    expect((patched.body as { isUrgent: boolean }).isUrgent).toBe(true);
    await as(
      api().patch(`/api/v1/appointment-types/${cleaningTypeId}`),
      caracas.adminToken,
    )
      .send({ isUrgent: false })
      .expect(200);
  });

  it('crear un reservado valida tipos, sede y liberación', async () => {
    const base = {
      providerId: dentist.userId,
      locationId,
      start: local('15:00').toISOString(),
      end: local('15:30').toISOString(),
      kind: 'RESERVED',
      releaseAtMinute: 660,
    };
    // Tipo de OTRA clínica: no existe para esta (RLS).
    const foreign = await as(
      api().post('/api/v1/schedule-blocks'),
      reception.token,
    )
      .send({ ...base, reservedForTypeIds: [madridUrgentTypeId] })
      .expect(404);
    expect((foreign.body as { message: string }).message).toBe(
      'Tipo de cita no encontrado',
    );
    const noTypes = await as(
      api().post('/api/v1/schedule-blocks'),
      reception.token,
    )
      .send({ ...base, reservedForTypeIds: [] })
      .expect(400);
    expect((noTypes.body as { message: string }).message).toMatch(
      /al menos un tipo/,
    );
    await as(api().post('/api/v1/schedule-blocks'), reception.token)
      .send({
        ...base,
        locationId: undefined,
        reservedForTypeIds: [urgentTypeId],
      })
      .expect(400);
    await as(api().post('/api/v1/schedule-blocks'), reception.token)
      .send({
        ...base,
        kind: 'MEETING',
        reservedForTypeIds: [urgentTypeId],
      })
      .expect(400);

    const created = await as(
      api().post('/api/v1/schedule-blocks'),
      reception.token,
    )
      .send({ ...base, reservedForTypeIds: [urgentTypeId], note: 'Urgencias' })
      .expect(201);
    blockId = (created.body as Body).id;
    expect(created.body).toMatchObject({
      kind: 'RESERVED',
      reservedForTypeIds: [urgentTypeId],
      releaseAtMinute: 660,
      allowsBooking: false,
    });
  });

  it('la agenda ve el reservado con sus tipos y su liberación', async () => {
    const [block] = await listBlocks(assistant.token);
    expect(block).toMatchObject({
      id: blockId,
      kind: 'RESERVED',
      reservedForTypes: [
        { id: urgentTypeId, name: 'Consulta de urgencia', isUrgent: true },
      ],
      releaseAt: local('11:00').toISOString(),
      released: false,
    });
  });

  it('«Limpieza» en el hueco reservado: 409 en español; «Consulta de urgencia»: 201', async () => {
    const rejected = await book(reception.token, {
      patientId: patients[0],
      providerId: dentist.userId,
      start: local('15:00'),
      appointmentTypeId: cleaningTypeId,
    }).expect(409);
    expect(rejected.body).toMatchObject({
      code: 'RESERVED_SLOT',
      message: RESERVED_MESSAGE,
      canOverride: false,
    });

    const allowed = await book(reception.token, {
      patientId: patients[0],
      providerId: dentist.userId,
      start: local('15:00'),
      appointmentTypeId: urgentTypeId,
    }).expect(201);
    expect((allowed.body as { warnings: string[] }).warnings).toEqual([]);
    await cancel((allowed.body as Body).id);
  });

  it('mover una «Limpieza» al hueco reservado también es 409', async () => {
    const outside = await book(reception.token, {
      patientId: patients[1],
      providerId: dentist.userId,
      start: local('16:00'),
      appointmentTypeId: cleaningTypeId,
    }).expect(201);
    const id = (outside.body as Body).id;
    const moved = await as(
      api().patch(`/api/v1/appointments/${id}`),
      reception.token,
    )
      .send({
        start: local('15:00').toISOString(),
        end: local('15:30').toISOString(),
      })
      .expect(409);
    expect((moved.body as { code: string }).code).toBe('RESERVED_SLOT');
    await cancel(id);
  });

  it('override: recepción y asistencia 403; el odontólogo con motivo agenda y queda auditado', async () => {
    const attempt = {
      patientId: patients[1],
      providerId: dentist.userId,
      start: local('15:00'),
      appointmentTypeId: cleaningTypeId,
    };
    await book(reception.token, {
      ...attempt,
      overrideReason: 'Paciente con dolor agudo',
    }).expect(403);
    await book(assistant.token, {
      ...attempt,
      overrideReason: 'Paciente con dolor agudo',
    }).expect(403);

    const offer = await book(dentist.token, attempt).expect(409);
    expect((offer.body as { canOverride: boolean }).canOverride).toBe(true);
    await book(dentist.token, { ...attempt, overrideReason: 'ay' }).expect(400);

    const forced = await book(dentist.token, {
      ...attempt,
      overrideReason: '  Paciente con dolor agudo  ',
    }).expect(201);
    const id = (forced.body as Body).id;
    expect((forced.body as Body).reservedOverride).toEqual({
      blockIds: [blockId],
      reason: 'Paciente con dolor agudo',
    });
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: caracas.tenantId,
        resourceType: 'APPOINTMENT',
        resourceId: id,
      },
    });
    const override = events.find(
      (e) =>
        (e.metadata as { reason?: string } | null)?.reason ===
        'RESERVED_SLOT_OVERRIDE',
    );
    expect(override).toMatchObject({
      actorUserId: dentist.userId,
      action: 'CREATE',
      metadata: {
        reason: 'RESERVED_SLOT_OVERRIDE',
        reservedSlotOverride: {
          blockIds: [blockId],
          reason: 'Paciente con dolor agudo',
        },
      },
    });
    await cancel(id);
  });

  it('Caracas: desde las 11:00 de la sede el hueco admite «Limpieza» y la agenda lo marca libre', async () => {
    clockNow = local('11:00');
    const [block] = await listBlocks(reception.token);
    expect(block).toMatchObject({ id: blockId, released: true });
    const booked = await book(reception.token, {
      patientId: patients[2],
      providerId: dentist.userId,
      start: local('15:00'),
      appointmentTypeId: cleaningTypeId,
    }).expect(201);
    await cancel((booked.body as Body).id);
    clockNow = local('10:59');
  });

  it('Madrid: la liberación va con la hora de Madrid, no con la de Caracas ni UTC', async () => {
    const madridAt = (hhmm: string) => at(MADRID_DAY, hhmm, MADRID.timeZone);
    const madridBlock = await as(
      api().post('/api/v1/schedule-blocks'),
      madrid.adminToken,
      madrid.host,
    )
      .send({
        providerId: madrid.adminUserId,
        locationId: madridLocationId,
        start: madridAt('15:00').toISOString(),
        end: madridAt('15:30').toISOString(),
        kind: 'RESERVED',
        reservedForTypeIds: [madridUrgentTypeId],
        releaseAtMinute: 660,
      })
      .expect(201);
    // Aislamiento: la agenda de Caracas no ve el bloque de Madrid.
    expect(
      (await listBlocks(caracas.adminToken, MADRID_DAY)).map((b) => b.id),
    ).not.toContain((madridBlock.body as Body).id);

    const attempt = {
      patientId: madridPatientId,
      providerId: madrid.adminUserId,
      start: madridAt('15:00'),
      appointmentTypeId: madridCleaningTypeId,
    };
    clockNow = madridAt('10:59');
    await book(madrid.adminToken, attempt, madrid.host).expect(409);
    clockNow = madridAt('11:00');
    const [block] = await listBlocks(
      madrid.adminToken,
      MADRID_DAY,
      MADRID.timeZone,
      madrid.host,
    );
    expect(block).toMatchObject({
      released: true,
      releaseAt: madridAt('11:00').toISOString(),
    });
    await book(madrid.adminToken, attempt, madrid.host).expect(201);
    clockNow = local('10:59');
  });

  it('cambiar el reservado a un tipo normal limpia tipos y liberación', async () => {
    const res = await as(
      api().patch(`/api/v1/schedule-blocks/${blockId}`),
      reception.token,
    )
      .send({ kind: 'MEETING' })
      .expect(200);
    expect(res.body).toMatchObject({
      kind: 'MEETING',
      reservedForTypeIds: [],
      releaseAtMinute: null,
    });
  });
});
