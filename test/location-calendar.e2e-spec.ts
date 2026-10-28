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
  REGIONAL_BERLIN_FIXTURE,
  locationBody,
} from './support/location-fixtures';
import { HOLIDAY_MESSAGES } from '../src/modules/location-calendar/domain/holiday-rules';

// DX-316 (G1.5): días hábiles y festivos de una sede, solo ADMIN, auditados
// sin el nombre del festivo. Un festivo ocupa su día como mucho una vez
// (R5): misma clase y clave, o un recurrente frente a un puntual del mismo
// día y mes, en las dos direcciones.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Holiday {
  id: string;
  date: string;
  name: string;
  recurring: boolean;
}
interface Calendar {
  locationId: string;
  workingWeekdays: number[];
  holidays: Holiday[];
}
interface ErrorBody {
  statusCode: number;
  code?: string;
  message: string | string[];
  holidayId?: string;
}

describe('Calendario de la sede: días hábiles y festivos (e2e, DX-316)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  const roleTokens: Partial<Record<ClinicRole, string>> = {};
  let sedes = 0;

  function api(clinic: Clinic, token = clinic.adminToken) {
    const server = app.getHttpServer();
    const auth = (t: request.Test) =>
      t
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
    return {
      get: (path: string) => auth(request(server).get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        auth(request(server).post(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        auth(request(server).put(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) =>
        auth(request(server).patch(`/api/v1${path}`)).send(body),
      delete: (path: string) => auth(request(server).delete(`/api/v1${path}`)),
    };
  }
  const admin = () => api(a);

  /** Una sede nueva de A por la API (cada test con la suya). */
  async function newLocation(): Promise<string> {
    sedes += 1;
    const res = await admin()
      .post(
        '/locations',
        locationBody(REGIONAL_BERLIN_FIXTURE, { name: `Sede ${sedes}` }),
      )
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function addHoliday(
    locationId: string,
    body: { date: string; name: string; recurring?: boolean },
  ): Promise<Holiday> {
    const res = await admin()
      .post(`/locations/${locationId}/holidays`, body)
      .expect(201);
    return res.body as Holiday;
  }

  const calendarOf = async (locationId: string): Promise<Calendar> =>
    (await admin().get(`/locations/${locationId}/calendar`).expect(200))
      .body as Calendar;

  const calendarEvents = (locationId: string) =>
    raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceType: 'LOCATION_CALENDAR',
        resourceId: locationId,
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx316-a');
    b = await registerClinic(app, 'dx316-b');
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const { email } = await seedMember(raw, a, role);
      roleTokens[role] = await loginAs(app, a.host, email);
    }
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('calendario por defecto (R2, R3)', () => {
    it('POST /locations creates a Monday–Friday calendar with no holidays', async () => {
      const id = await newLocation();
      expect(await calendarOf(id)).toEqual({
        locationId: id,
        workingWeekdays: [1, 2, 3, 4, 5],
        holidays: [],
      });
    });

    it('registration creates the main location with a Monday–Friday calendar', async () => {
      const [main] = (await admin().get('/locations').expect(200)).body as {
        id: string;
      }[];
      expect(await calendarOf(main.id)).toEqual({
        locationId: main.id,
        workingWeekdays: [1, 2, 3, 4, 5],
        holidays: [],
      });
    });
  });

  describe('días hábiles', () => {
    it('PUT working-weekdays [0,4,3,2,1,1] stores [0,1,2,3,4] and audits before/after', async () => {
      const id = await newLocation();
      const res = await admin()
        .put(`/locations/${id}/calendar/working-weekdays`, {
          workingWeekdays: [0, 4, 3, 2, 1, 1],
        })
        .expect(200);
      expect(res.body).toEqual({
        locationId: id,
        workingWeekdays: [0, 1, 2, 3, 4],
        holidays: [],
      });
      expect((await calendarOf(id)).workingWeekdays).toEqual([0, 1, 2, 3, 4]);
      const events = await calendarEvents(id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'UPDATE',
        actorUserId: a.adminUserId,
        metadata: {
          reason: 'WORKING_WEEKDAYS_CHANGED',
          changedFields: ['workingWeekdays'],
          locationCalendar: {
            workingWeekdays: {
              before: [1, 2, 3, 4, 5],
              after: [0, 1, 2, 3, 4],
            },
          },
        },
      });
    });

    it('PUT with the same days leaves no audit event', async () => {
      const id = await newLocation();
      await admin()
        .put(`/locations/${id}/calendar/working-weekdays`, {
          workingWeekdays: [5, 4, 3, 2, 1],
        })
        .expect(200);
      expect(await calendarEvents(id)).toEqual([]);
    });

    it('PUT [] is 400 «Elige al menos un día hábil.»', async () => {
      const id = await newLocation();
      const res = await admin()
        .put(`/locations/${id}/calendar/working-weekdays`, {
          workingWeekdays: [],
        })
        .expect(400);
      expect((res.body as ErrorBody).message).toEqual([
        'Elige al menos un día hábil.',
      ]);
    });

    it('PUT [7] is 400 «Los días hábiles van de 0 (domingo) a 6 (sábado).»', async () => {
      const id = await newLocation();
      for (const workingWeekdays of [[7], [-1], [1.5], ['1']]) {
        const res = await admin()
          .put(`/locations/${id}/calendar/working-weekdays`, {
            workingWeekdays,
          })
          .expect(400);
        expect((res.body as ErrorBody).message).toEqual([
          'Los días hábiles van de 0 (domingo) a 6 (sábado).',
        ]);
      }
      expect((await calendarOf(id)).workingWeekdays).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('festivos', () => {
    it('POST holiday 201', async () => {
      const id = await newLocation();
      const res = await admin()
        .post(`/locations/${id}/holidays`, {
          date: '2027-05-03',
          name: '  Cierre anual  ',
        })
        .expect(201);
      const body = res.body as Holiday;
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(body).toEqual({
        id: body.id,
        date: '2027-05-03',
        name: 'Cierre anual',
        recurring: false,
      });
    });

    it('same date is 409 HOLIDAY_ALREADY_EXISTS with holidayId', async () => {
      const id = await newLocation();
      const first = await addHoliday(id, {
        date: '2027-05-03',
        name: 'Cierre anual',
      });
      const res = await admin()
        .post(`/locations/${id}/holidays`, {
          date: '2027-05-03',
          name: 'Otro nombre',
        })
        .expect(409);
      expect(res.body).toEqual({
        statusCode: 409,
        error: 'Conflict',
        code: 'HOLIDAY_ALREADY_EXISTS',
        message: 'Ya hay un festivo ese día: «Cierre anual».',
        holidayId: first.id,
      });
      // Dos recurrentes del mismo día y mes, de años distintos, también.
      const yearly = await addHoliday(id, {
        date: '2001-12-31',
        name: 'Fin de año',
        recurring: true,
      });
      const again = await admin()
        .post(`/locations/${id}/holidays`, {
          date: '2030-12-31',
          name: 'Fin de año',
          recurring: true,
        })
        .expect(409);
      expect((again.body as ErrorBody).holidayId).toBe(yearly.id);
    });

    it('a one-off on a recurring day is 409 «Ese día ya es festivo cada año…»', async () => {
      const id = await newLocation();
      const yearly = await addHoliday(id, {
        date: '2030-05-03',
        name: 'Festivo de prueba 01',
        recurring: true,
      });
      // También en un año anterior al guardado (R6).
      const res = await admin()
        .post(`/locations/${id}/holidays`, {
          date: '2027-05-03',
          name: 'Puntual',
        })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'HOLIDAY_ALREADY_EXISTS',
        message: 'Ese día ya es festivo cada año: «Festivo de prueba 01».',
        holidayId: yearly.id,
      });
    });

    it('a recurring holiday over an existing one-off is 409 «Ya hay un festivo puntual ese día y mes…»', async () => {
      const id = await newLocation();
      await addHoliday(id, { date: '2031-05-03', name: 'Puntual tardío' });
      const first = await addHoliday(id, {
        date: '2027-05-03',
        name: 'Puntual',
      });
      const res = await admin()
        .post(`/locations/${id}/holidays`, {
          date: '2030-05-03',
          name: 'Cada año',
          recurring: true,
        })
        .expect(409);
      // El primero por fecha si hay varios.
      expect(res.body).toMatchObject({
        code: 'HOLIDAY_ALREADY_EXISTS',
        message:
          'Ya hay un festivo puntual ese día y mes: «Puntual». Elimínalo antes de crear uno que se repita cada año.',
        holidayId: first.id,
      });
    });

    it('PATCH recurring=true onto a day with a one-off is 409', async () => {
      const id = await newLocation();
      const oneOff = await addHoliday(id, {
        date: '2027-05-03',
        name: 'Puntual',
      });
      const other = await addHoliday(id, {
        date: '2028-05-03',
        name: 'Otro puntual',
      });
      const res = await admin()
        .patch(`/locations/${id}/holidays/${other.id}`, { recurring: true })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'HOLIDAY_ALREADY_EXISTS',
        holidayId: oneOff.id,
      });
      expect((await calendarOf(id)).holidays).toEqual([oneOff, other]);
    });

    it('PATCH a holiday onto its own date is 200', async () => {
      const id = await newLocation();
      const yearly = await addHoliday(id, {
        date: '2027-05-03',
        name: 'Cada año',
        recurring: true,
      });
      const res = await admin()
        .patch(`/locations/${id}/holidays/${yearly.id}`, {
          date: '2027-05-03',
          recurring: true,
        })
        .expect(200);
      expect(res.body).toEqual(yearly);
      // Pasar a puntual el mismo día tampoco choca consigo mismo.
      await admin()
        .patch(`/locations/${id}/holidays/${yearly.id}`, { recurring: false })
        .expect(200);
    });

    it('recurring 29 February is 400', async () => {
      const id = await newLocation();
      const res = await admin()
        .post(`/locations/${id}/holidays`, {
          date: '2028-02-29',
          name: 'Bisiesto',
          recurring: true,
        })
        .expect(400);
      expect((res.body as ErrorBody).message).toBe(
        HOLIDAY_MESSAGES.recurringFeb29,
      );
      // Un puntual del 29 de febrero de un bisiesto sí vale, pero no puede
      // pasar a recurrente.
      const leap = await addHoliday(id, {
        date: '2028-02-29',
        name: 'Bisiesto',
      });
      const patch = await admin()
        .patch(`/locations/${id}/holidays/${leap.id}`, { recurring: true })
        .expect(400);
      expect((patch.body as ErrorBody).message).toBe(
        HOLIDAY_MESSAGES.recurringFeb29,
      );
    });

    it('a date that is not ISO or out of range, or a bad name, is 400 with the spec text', async () => {
      const id = await newLocation();
      const cases: [object, string][] = [
        [
          { date: '03/05/2027', name: 'X' },
          'Fecha «03/05/2027» no válida: usa AAAA-MM-DD, por ejemplo 2027-05-03.',
        ],
        [
          { date: '2027-02-30', name: 'X' },
          'Fecha «2027-02-30» no válida: usa AAAA-MM-DD, por ejemplo 2027-05-03.',
        ],
        [
          { date: '1999-12-31', name: 'X' },
          'La fecha tiene que estar entre 2000 y 2100.',
        ],
        [
          { date: '2027-05-03', name: '   ' },
          'El nombre es obligatorio (hasta 120 caracteres).',
        ],
        [
          { date: '2027-05-03', name: 'x'.repeat(121) },
          'El nombre es obligatorio (hasta 120 caracteres).',
        ],
      ];
      for (const [body, message] of cases) {
        const res = await admin()
          .post(`/locations/${id}/holidays`, body)
          .expect(400);
        expect((res.body as ErrorBody).message).toBe(message);
      }
      const missing = await admin()
        .post(`/locations/${id}/holidays`, {})
        .expect(400);
      expect((missing.body as ErrorBody).message).toEqual(
        expect.arrayContaining([
          'Fecha «» no válida: usa AAAA-MM-DD, por ejemplo 2027-05-03.',
          'El nombre es obligatorio (hasta 120 caracteres).',
        ]),
      );
      expect((await calendarOf(id)).holidays).toEqual([]);
    });

    it('PATCH name only audits changedFields [name] without the name', async () => {
      const id = await newLocation();
      const holiday = await addHoliday(id, {
        date: '2027-05-03',
        name: 'Cierre anual',
      });
      const res = await admin()
        .patch(`/locations/${id}/holidays/${holiday.id}`, {
          name: 'Cierre de verano',
        })
        .expect(200);
      expect(res.body).toEqual({ ...holiday, name: 'Cierre de verano' });
      const events = await calendarEvents(id);
      expect(events.at(-1)).toMatchObject({
        action: 'UPDATE',
        metadata: {
          reason: 'HOLIDAY_UPDATED',
          changedFields: ['name'],
          locationCalendar: {
            holiday: {
              before: { date: '2027-05-03', recurring: false },
              after: { date: '2027-05-03', recurring: false },
            },
          },
        },
      });
      expect(JSON.stringify(events)).not.toMatch(/Cierre/);
    });

    it('PATCH null date is 400', async () => {
      const id = await newLocation();
      const holiday = await addHoliday(id, {
        date: '2027-05-03',
        name: 'Cierre anual',
      });
      for (const [field, label] of [
        ['date', 'fecha'],
        ['name', 'nombre'],
        ['recurring', 'recurrente'],
      ]) {
        const res = await admin()
          .patch(`/locations/${id}/holidays/${holiday.id}`, { [field]: null })
          .expect(400);
        expect((res.body as ErrorBody).message).toBe(
          `Indica un valor para «${label}».`,
        );
      }
      expect((await calendarOf(id)).holidays).toEqual([holiday]);
    });

    it('PATCH into an existing date is 409', async () => {
      const id = await newLocation();
      const first = await addHoliday(id, { date: '2027-05-03', name: 'Uno' });
      const second = await addHoliday(id, { date: '2027-05-04', name: 'Dos' });
      const res = await admin()
        .patch(`/locations/${id}/holidays/${second.id}`, {
          date: '2027-05-03',
        })
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'HOLIDAY_ALREADY_EXISTS',
        message: 'Ya hay un festivo ese día: «Uno».',
        holidayId: first.id,
      });
    });

    it('DELETE answers 204 with no body', async () => {
      const id = await newLocation();
      const holiday = await addHoliday(id, {
        date: '2027-05-03',
        name: 'Cierre anual',
      });
      const res = await admin()
        .delete(`/locations/${id}/holidays/${holiday.id}`)
        .expect(204);
      expect(res.text).toBe('');
    });

    it('DELETE retires (deletedAt) and the date can be added again', async () => {
      const id = await newLocation();
      const holiday = await addHoliday(id, {
        date: '2027-05-03',
        name: 'Cierre anual',
      });
      await admin()
        .delete(`/locations/${id}/holidays/${holiday.id}`)
        .expect(204);
      const row = await raw.locationHoliday.findUniqueOrThrow({
        where: { id: holiday.id },
      });
      expect(row.deletedAt).toBeInstanceOf(Date);
      expect((await calendarOf(id)).holidays).toEqual([]);
      // Retirado ya no se encuentra.
      await admin()
        .delete(`/locations/${id}/holidays/${holiday.id}`)
        .expect(404);
      await admin()
        .patch(`/locations/${id}/holidays/${holiday.id}`, { name: 'Otra vez' })
        .expect(404);
      const again = await addHoliday(id, {
        date: '2027-05-03',
        name: 'Cierre anual',
      });
      expect(again.id).not.toBe(holiday.id);
    });

    it('GET orders recurring by month-day, then one-off by date', async () => {
      const id = await newLocation();
      const oneOffLate = await addHoliday(id, {
        date: '2028-01-02',
        name: 'Puntual 2028',
      });
      const yearlyDec = await addHoliday(id, {
        date: '2000-12-24',
        name: 'Cada año diciembre',
        recurring: true,
      });
      const oneOffEarly = await addHoliday(id, {
        date: '2027-06-01',
        name: 'Puntual 2027',
      });
      const yearlyJan = await addHoliday(id, {
        date: '2040-01-06',
        name: 'Cada año enero',
        recurring: true,
      });
      expect((await calendarOf(id)).holidays).toEqual([
        yearlyJan,
        yearlyDec,
        oneOffEarly,
        oneOffLate,
      ]);
    });
  });

  describe('acceso y aislamiento', () => {
    it('another clinic gets 404 for this location calendar', async () => {
      const id = await newLocation();
      const holiday = await addHoliday(id, {
        date: '2027-05-03',
        name: 'Cierre anual',
      });
      const other = api(b);
      const responses = [
        await other.get(`/locations/${id}/calendar`),
        await other.put(`/locations/${id}/calendar/working-weekdays`, {
          workingWeekdays: [0],
        }),
        await other.post(`/locations/${id}/holidays`, {
          date: '2027-05-04',
          name: 'Intruso',
        }),
        await other.patch(`/locations/${id}/holidays/${holiday.id}`, {
          name: 'Intruso',
        }),
        await other.delete(`/locations/${id}/holidays/${holiday.id}`),
      ];
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({
          code: 'LOCATION_NOT_FOUND',
          message: 'No encontramos esa sede.',
        });
      }
      expect(await calendarOf(id)).toEqual({
        locationId: id,
        workingWeekdays: [1, 2, 3, 4, 5],
        holidays: [holiday],
      });
    });

    it('a holiday id of another location is 404', async () => {
      const id = await newLocation();
      const otherId = await newLocation();
      const holiday = await addHoliday(id, {
        date: '2027-05-03',
        name: 'Cierre anual',
      });
      for (const res of [
        await admin().patch(`/locations/${otherId}/holidays/${holiday.id}`, {
          name: 'Cambiado',
        }),
        await admin().delete(`/locations/${otherId}/holidays/${holiday.id}`),
        await admin().delete(
          `/locations/${otherId}/holidays/00000000-0000-4000-8000-000000000000`,
        ),
        await admin().delete(`/locations/${otherId}/holidays/no-es-un-id`),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({
          code: 'HOLIDAY_NOT_FOUND',
          message: 'No encontramos ese festivo.',
        });
      }
      expect((await calendarOf(id)).holidays).toEqual([holiday]);
    });

    it('a retired location is 404, an inactive one is editable', async () => {
      const inactive = await newLocation();
      await admin()
        .patch(`/locations/${inactive}`, { isActive: false })
        .expect(200);
      await addHoliday(inactive, { date: '2027-05-03', name: 'Cierre' });
      await admin()
        .put(`/locations/${inactive}/calendar/working-weekdays`, {
          workingWeekdays: [1, 2, 3],
        })
        .expect(200);

      const retired = await newLocation();
      await raw.location.update({
        where: { id: retired },
        data: { deletedAt: new Date() },
      });
      for (const res of [
        await admin().get(`/locations/${retired}/calendar`),
        await admin().put(`/locations/${retired}/calendar/working-weekdays`, {
          workingWeekdays: [1],
        }),
        await admin().post(`/locations/${retired}/holidays`, {
          date: '2027-05-03',
          name: 'Cierre',
        }),
        await admin().get('/locations/no-es-un-id/calendar'),
      ]) {
        expect(res.status).toBe(404);
        expect((res.body as ErrorBody).code).toBe('LOCATION_NOT_FOUND');
      }
    });

    it('DENTIST, ASSISTANT and RECEPTION get 403 with the Spanish message', async () => {
      const id = await newLocation();
      for (const role of [
        ClinicRole.DENTIST,
        ClinicRole.ASSISTANT,
        ClinicRole.RECEPTION,
      ]) {
        const as = api(a, roleTokens[role]);
        for (const res of [
          await as.get(`/locations/${id}/calendar`),
          await as.post(`/locations/${id}/holidays`, {
            date: '2027-05-03',
            name: 'Cierre',
          }),
        ]) {
          expect(res.status).toBe(403);
          expect((res.body as ErrorBody).message).toBe(
            'Solo un administrador de la clínica puede ver o cambiar el calendario de la sede.',
          );
        }
      }
      expect((await calendarOf(id)).holidays).toEqual([]);
    });
  });

  it('each calendar change leaves one LOCATION_CALENDAR audit event without the holiday name', async () => {
    const id = await newLocation();
    await admin()
      .put(`/locations/${id}/calendar/working-weekdays`, {
        workingWeekdays: [0, 1, 2, 3, 4],
      })
      .expect(200);
    const holiday = await addHoliday(id, {
      date: '2027-05-03',
      name: 'Nombre secreto',
    });
    await admin()
      .patch(`/locations/${id}/holidays/${holiday.id}`, {
        date: '2027-05-04',
        recurring: true,
      })
      .expect(200);
    await admin().delete(`/locations/${id}/holidays/${holiday.id}`).expect(204);
    // Ni la lectura ni un 409 dejan evento.
    await calendarOf(id);
    await admin()
      .put(`/locations/${id}/calendar/working-weekdays`, {
        workingWeekdays: [],
      })
      .expect(400);

    const events = await calendarEvents(id);
    expect(
      events.map((e) => ({
        action: e.action,
        resourceId: e.resourceId,
        actorUserId: e.actorUserId,
        metadata: e.metadata,
      })),
    ).toEqual([
      {
        action: 'UPDATE',
        resourceId: id,
        actorUserId: a.adminUserId,
        metadata: {
          params: { id },
          reason: 'WORKING_WEEKDAYS_CHANGED',
          changedFields: ['workingWeekdays'],
          locationCalendar: {
            workingWeekdays: {
              before: [1, 2, 3, 4, 5],
              after: [0, 1, 2, 3, 4],
            },
          },
        },
      },
      {
        action: 'CREATE',
        resourceId: id,
        actorUserId: a.adminUserId,
        metadata: {
          params: { id },
          reason: 'HOLIDAY_CREATED',
          locationCalendar: {
            holiday: { after: { date: '2027-05-03', recurring: false } },
          },
        },
      },
      {
        action: 'UPDATE',
        resourceId: id,
        actorUserId: a.adminUserId,
        metadata: {
          params: { id, holidayId: holiday.id },
          reason: 'HOLIDAY_UPDATED',
          changedFields: ['date', 'recurring'],
          locationCalendar: {
            holiday: {
              before: { date: '2027-05-03', recurring: false },
              after: { date: '2027-05-04', recurring: true },
            },
          },
        },
      },
      {
        action: 'DELETE',
        resourceId: id,
        actorUserId: a.adminUserId,
        metadata: {
          params: { id, holidayId: holiday.id },
          reason: 'HOLIDAY_DELETED',
          locationCalendar: {
            holiday: { before: { date: '2027-05-04', recurring: true } },
          },
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('Nombre secreto');
  });
});
