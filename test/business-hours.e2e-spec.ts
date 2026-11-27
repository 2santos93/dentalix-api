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
  REGIONAL_MEXICO_CITY_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  locationBody,
} from './support/location-fixtures';
import { fixedSedeDay } from './support/sede-clock';
import {
  addCivilDays,
  civilWeekday,
  zonedWallTime,
} from '../src/shared/time/civil-day';

// DX-069: el horario de atención con la semana lun–vie 9–13 en la zona IANA de
// CADA sede (Ciudad de México y Tokio, a 15 horas), sin desactivarlo como
// hacen los demás specs que agendan. Agendar y reagendar fuera de horario es
// 422 (DX-121: la petición es válida, pero el hueco no existe); la sede B se
// valida con su propio horario aunque la sede en contexto sea la A (BE-003), y
// solo ADMIN cambia el horario.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const MX = REGIONAL_MEXICO_CITY_FIXTURE.timeZone;
const TOKYO = REGIONAL_TOKYO_FIXTURE.timeZone;
const WEEK_9_TO_13 = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 9 * 60,
  endMinute: 13 * 60,
}));

// Un lunes al menos una semana después del «hoy» fijo de la sede (DX-209):
// futuro para el reloj real de la API corra la suite a la hora que corra.
const MONDAY = (() => {
  let day = fixedSedeDay(-7).day;
  while (civilWeekday(day) !== 1) day = addCivilDays(day, 1);
  return day;
})();
const SUNDAY = addCivilDays(MONDAY, 6);

/** Media hora desde las `hour`:00 de pared del día `day` en `zone`. */
function slot(day: string, hour: number, zone: string) {
  const start = zonedWallTime(day, hour * 60, zone);
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 30 * 60_000).toISOString(),
  };
}

describe('Horario de atención por sede al agendar y reagendar (e2e, DX-069)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let mexicoId: string;
  let tokyoId: string;
  let patientId: string;

  const api = () => request(app.getHttpServer());
  const as = (
    req: request.Test,
    locationId: string,
    token = clinic.adminToken,
  ): request.Test =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Location-Id', locationId);
  const book = (locationId: string, when: { start: string; end: string }) =>
    as(api().post('/api/v1/appointments'), locationId).send({
      patientId,
      providerId: clinic.adminUserId,
      ...when,
    });
  const move = (
    id: string,
    locationId: string,
    when: { start: string; end: string },
  ) => as(api().patch(`/api/v1/appointments/${id}`), locationId).send(when);
  const message = (res: request.Response) =>
    (res.body as { message: string }).message;
  const scheduleOf = async (locationId: string) =>
    (await as(api().get('/api/v1/locations/schedule'), locationId).expect(200))
      .body as { timezone: string; ranges: unknown[] };

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(
      app,
      'dx069-horario',
      REGIONAL_MEXICO_CITY_FIXTURE,
    );
    mexicoId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        select: { id: true },
      })
    ).id;
    const tokyo = await as(api().post('/api/v1/locations'), mexicoId)
      .send(locationBody(REGIONAL_TOKYO_FIXTURE, { name: 'Tokio' }))
      .expect(201);
    tokyoId = (tokyo.body as { id: string }).id;
    for (const locationId of [mexicoId, tokyoId]) {
      await as(api().put('/api/v1/locations/schedule'), locationId)
        .send({ ranges: WEEK_9_TO_13 })
        .expect(200);
    }
    const patient = await as(api().post('/api/v1/patients'), mexicoId)
      .send({
        firstName: 'María',
        lastName: 'Pérez',
        docType: 'NATIONAL_ID',
        docNumber: 'V-20690690',
        sex: 'F',
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
  }, 180_000);

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  }, 180_000);

  it('el lunes y el domingo del spec lo son, y cada sede tiene su zona', async () => {
    expect(civilWeekday(MONDAY)).toBe(1);
    expect(civilWeekday(SUNDAY)).toBe(0);
    expect(await scheduleOf(mexicoId)).toEqual({
      timezone: MX,
      ranges: WEEK_9_TO_13,
    });
    expect((await scheduleOf(tokyoId)).timezone).toBe(TOKYO);
  });

  describe('sede A (Ciudad de México)', () => {
    let appointmentId: string;

    it('agendar el lunes a las 08:00 de México es 422 con el horario del día', async () => {
      const res = await book(mexicoId, slot(MONDAY, 8, MX)).expect(422);
      expect(message(res)).toBe(
        'Fuera del horario de atención (lunes: 09:00–13:00)',
      );
    });

    it('agendar el lunes a las 10:00 de México es 201', async () => {
      const res = await book(mexicoId, slot(MONDAY, 10, MX)).expect(201);
      appointmentId = (res.body as { id: string }).id;
    });

    it('reagendar (PATCH) esa cita a las 14:00 es 422 y la cita no se mueve', async () => {
      const res = await move(
        appointmentId,
        mexicoId,
        slot(MONDAY, 14, MX),
      ).expect(422);
      expect(message(res)).toBe(
        'Fuera del horario de atención (lunes: 09:00–13:00)',
      );
      const stored = await raw.appointment.findUniqueOrThrow({
        where: { id: appointmentId },
        select: { start: true },
      });
      expect(stored.start.toISOString()).toBe(slot(MONDAY, 10, MX).start);
    });

    it('agendar el domingo es 422 «la sede no atiende los domingos»', async () => {
      const res = await book(mexicoId, slot(SUNDAY, 10, MX)).expect(422);
      expect(message(res)).toBe('La sede no atiende los domingos');
    });

    it('reagendar dentro del horario (lunes 11:00) es 200', async () => {
      await move(appointmentId, mexicoId, slot(MONDAY, 11, MX)).expect(200);
    });
  });

  describe('sede B (Tokio): se valida con SU horario y SU zona', () => {
    let tokyoAppointmentId: string;

    it('las 10:00 de Tokio son 201', async () => {
      const res = await book(tokyoId, slot(MONDAY, 10, TOKYO)).expect(201);
      tokyoAppointmentId = (res.body as { id: string }).id;
    });

    it('las 10:00 de México (01:00 del martes en Tokio) son 422 con el horario de Tokio', async () => {
      const res = await book(tokyoId, slot(MONDAY, 10, MX)).expect(422);
      expect(message(res)).toBe(
        'Fuera del horario de atención (martes: 09:00–13:00)',
      );
    });

    // BE-003 (DX-056): con la sede A en la cabecera, el horario que manda al
    // reagendar es el de la sede DE LA CITA.
    it('BE-003: con la sede de México en contexto, mover la cita de Tokio a las 10:00 de México es 422', async () => {
      const res = await move(
        tokyoAppointmentId,
        mexicoId,
        slot(MONDAY, 10, MX),
      ).expect(422);
      expect(message(res)).toBe(
        'Fuera del horario de atención (martes: 09:00–13:00)',
      );
    });

    it('BE-003: con la sede de México en contexto, mover la cita de Tokio a las 11:00 de Tokio es 200 y sigue en Tokio', async () => {
      await move(tokyoAppointmentId, mexicoId, slot(MONDAY, 11, TOKYO)).expect(
        200,
      );
      const stored = await raw.appointment.findUniqueOrThrow({
        where: { id: tokyoAppointmentId },
        select: { start: true, locationId: true },
      });
      expect(stored).toEqual({
        start: new Date(slot(MONDAY, 11, TOKYO).start),
        locationId: tokyoId,
      });
    });
  });

  describe('PUT /locations/schedule', () => {
    it.each([ClinicRole.DENTIST, ClinicRole.RECEPTION])(
      '%s no cambia el horario (403) y la semana sigue igual',
      async (role) => {
        const member = await seedMember(raw, clinic, role);
        const token = await loginAs(app, clinic.host, member.email);
        await as(api().put('/api/v1/locations/schedule'), mexicoId, token)
          .send({ ranges: [] })
          .expect(403);
        // Leerlo sí puede (lo necesita para agendar).
        const res = await as(
          api().get('/api/v1/locations/schedule'),
          mexicoId,
          token,
        ).expect(200);
        expect((res.body as { ranges: unknown[] }).ranges).toEqual(
          WEEK_9_TO_13,
        );
      },
    );

    it.each([
      [
        'tramos solapados',
        [
          { weekday: 1, startMinute: 540, endMinute: 780 },
          { weekday: 1, startMinute: 720, endMinute: 900 },
        ],
        'Hay tramos solapados en el mismo día; únelos en uno',
      ],
      [
        'startMinute >= endMinute',
        [{ weekday: 1, startMinute: 780, endMinute: 540 }],
        'El fin de un tramo debe ser posterior a su inicio',
      ],
    ])('%s → 400 y no se guarda', async (_label, ranges, expected) => {
      const res = await as(api().put('/api/v1/locations/schedule'), mexicoId)
        .send({ ranges })
        .expect(400);
      expect(message(res)).toBe(expected);
      expect((await scheduleOf(mexicoId)).ranges).toEqual(WEEK_9_TO_13);
    });

    it('una zona inexistente → 400 y no se guarda', async () => {
      const res = await as(api().put('/api/v1/locations/schedule'), mexicoId)
        .send({ timezone: 'Marte/Olympus_Mons', ranges: [] })
        .expect(400);
      expect(message(res)).toBe(
        'La zona horaria ya no se guarda en el horario: es un dato de la sede (Ajustes → Sedes).',
      );
      expect((await scheduleOf(mexicoId)).ranges).toEqual(WEEK_9_TO_13);
    });

    it('ranges: [] deja la sede sin restricción: el domingo se agenda', async () => {
      await as(api().put('/api/v1/locations/schedule'), tokyoId)
        .send({ ranges: [] })
        .expect(200);
      await book(tokyoId, slot(SUNDAY, 10, TOKYO)).expect(201);
      // La otra sede conserva su horario.
      await book(mexicoId, slot(SUNDAY, 11, MX)).expect(422);
    });
  });
});
