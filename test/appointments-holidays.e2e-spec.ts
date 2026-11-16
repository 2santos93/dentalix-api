import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  registerClinic,
  resetDatabase,
} from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationBody,
} from './support/location-fixtures';

// DX-263-bis: crear o mover una cita a mano respeta los festivos de la sede
// (DX-316), en su zona (America/Caracas, UTC−4). Un festivo es 409
// `LOCATION_HOLIDAY` con su nombre; las demás sedes no se ven afectadas;
// «Buscar hueco» no ofrece ese día.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface ErrorBody {
  statusCode: number;
  code?: string;
  message: string;
  holiday?: { date: string; name: string };
}

describe('Festivos de la sede al agendar y mover (e2e, DX-263-bis)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let mainId: string;
  let otherId: string;
  let patientId: string;
  let holidayId: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, locationId = mainId): request.Test =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`)
      .set('X-Location-Id', locationId);

  // Lunes y martes de dentro de dos semanas: una fecha fija caduca.
  const monday = (() => {
    const day = new Date(Date.now() + 7 * 86_400_000);
    day.setUTCDate(day.getUTCDate() + ((8 - day.getUTCDay()) % 7 || 7));
    return day.toISOString().slice(0, 10);
  })();
  const tuesday = (() => {
    const day = new Date(`${monday}T12:00:00.000Z`);
    day.setUTCDate(day.getUTCDate() + 1);
    return day.toISOString().slice(0, 10);
  })();
  // 10:00–10:30 de Caracas = 14:00Z–14:30Z (horario de alta: 9–13).
  const tenAm = (day: string) => ({
    start: `${day}T14:00:00.000Z`,
    end: `${day}T14:30:00.000Z`,
  });

  const book = (day: string, locationId = mainId) =>
    as(api().post('/api/v1/appointments'), locationId).send({
      patientId,
      providerId: clinic.adminUserId,
      ...tenAm(day),
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx263b-e2e');
    const main = await raw.location.findFirstOrThrow({
      where: { tenantId: clinic.tenantId },
      select: { id: true },
    });
    mainId = main.id;
    const other = await as(api().post('/api/v1/locations'))
      .send(locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Este' }))
      .expect(201);
    otherId = (other.body as { id: string }).id;
    const patient = await as(api().post('/api/v1/patients'))
      .send({
        firstName: 'Ana',
        lastName: 'Festivo',
        docType: 'NATIONAL_ID',
        docNumber: '2630001',
        sex: 'F',
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
    const holiday = await as(api().post(`/api/v1/locations/${mainId}/holidays`))
      .send({ date: monday, name: 'Fiesta de la sede', recurring: false })
      .expect(201);
    holidayId = (holiday.body as { id: string }).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('crear una cita en un festivo de la sede: 409 LOCATION_HOLIDAY con su nombre', async () => {
    const res = await book(monday).expect(409);
    expect(res.body as ErrorBody).toMatchObject({
      statusCode: 409,
      code: 'LOCATION_HOLIDAY',
      message:
        'Ese día la sede está cerrada por festivo («Fiesta de la sede»): elige otro día.',
      holiday: { date: monday, name: 'Fiesta de la sede' },
    });
    expect(
      await raw.appointment.count({
        where: { tenantId: clinic.tenantId, locationId: mainId },
      }),
    ).toBe(0);
  });

  it('otra sede de la misma clínica no se ve afectada', async () => {
    await book(monday, otherId).expect(201);
  });

  it('mover una cita a un festivo: 409; a un día abierto: 200', async () => {
    const created = await book(tuesday).expect(201);
    const id = (created.body as { id: string }).id;
    const moved = await as(api().patch(`/api/v1/appointments/${id}`))
      .send(tenAm(monday))
      .expect(409);
    expect((moved.body as ErrorBody).code).toBe('LOCATION_HOLIDAY');
    const row = await raw.appointment.findUniqueOrThrow({ where: { id } });
    expect(row.start.toISOString()).toBe(tenAm(tuesday).start);

    // Una hora más tarde el mismo martes: sin festivo, se mueve.
    await as(api().patch(`/api/v1/appointments/${id}`))
      .send({
        start: `${tuesday}T15:00:00.000Z`,
        end: `${tuesday}T15:30:00.000Z`,
      })
      .expect(200);
  });

  it('«Buscar hueco» no ofrece el festivo y lo nombra en `holidays`', async () => {
    const res = await as(api().get('/api/v1/appointments/openings'))
      .query({
        providerId: clinic.adminUserId,
        locationId: mainId,
        from: monday,
        to: tuesday,
        durationMinutes: 30,
      })
      .expect(200);
    const body = res.body as {
      openings: { start: string }[];
      holidays: { date: string; name: string }[];
    };
    expect(body.holidays).toEqual([
      { date: monday, name: 'Fiesta de la sede' },
    ]);
    expect(body.openings.length).toBeGreaterThan(0);
    // Ningún hueco el lunes en Caracas (de 04:00Z del lunes a 04:00Z del martes).
    const mondayStart = Date.parse(`${monday}T04:00:00.000Z`);
    const mondayEnd = Date.parse(`${tuesday}T04:00:00.000Z`);
    for (const o of body.openings) {
      const t = Date.parse(o.start);
      expect(t >= mondayStart && t < mondayEnd).toBe(false);
    }
  });

  it('«Buscar hueco» en la otra sede sí ofrece ese lunes', async () => {
    const res = await as(api().get('/api/v1/appointments/openings'), otherId)
      .query({
        providerId: clinic.adminUserId,
        locationId: otherId,
        from: monday,
        to: monday,
        durationMinutes: 30,
      })
      .expect(200);
    const body = res.body as { openings: unknown[]; holidays: unknown[] };
    expect(body.holidays).toEqual([]);
    expect(body.openings.length).toBeGreaterThan(0);
  });

  it('si la clínica abre ese día, retirar el festivo vuelve a dejar agendar', async () => {
    await as(
      api().delete(`/api/v1/locations/${mainId}/holidays/${holidayId}`),
    ).expect(204);
    // A las 11:00 (la de las 10:00 ya es de la otra sede, mismo profesional).
    await as(api().post('/api/v1/appointments'))
      .send({
        patientId,
        providerId: clinic.adminUserId,
        start: `${monday}T15:00:00.000Z`,
        end: `${monday}T15:30:00.000Z`,
      })
      .expect(201);
  });
});
