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
  REGIONAL_TOKYO_FIXTURE,
  legacyLocationInsert,
  locationBody,
} from './support/location-fixtures';

// GLOBAL-G1 fase 1 (spec §3.4, R15, R20): la zona es un dato de la sede. El
// PUT del horario ya no la guarda; una web antigua que aún la envía solo pasa
// si es la de la sede. La columna legada del horario se mantiene igual a la
// zona de la sede para las réplicas antiguas.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const WEEK = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startMinute: 8 * 60,
  endMinute: 17 * 60,
}));
const MOVED =
  'La zona horaria ya no se guarda en el horario: es un dato de la sede (Ajustes → Sedes).';

describe('Horario de la sede sin zona propia (e2e, G1)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let mainId: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, locationId?: string): request.Test => {
    const authed = req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);
    return locationId ? authed.set('X-Location-Id', locationId) : authed;
  };
  const legacyZone = async (locationId: string) =>
    (
      await raw.locationSchedule.findFirstOrThrow({
        where: { locationId, deletedAt: null },
        select: { timezone: true },
      })
    ).timezone;

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'g1-schedule-e2e');
    mainId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('PUT schedule without timezone is 200', async () => {
    const res = await as(api().put('/api/v1/locations/schedule'), mainId)
      .send({ ranges: WEEK })
      .expect(200);
    expect(res.body).toEqual({ timezone: 'America/Bogota', ranges: WEEK });
  });

  it("PUT schedule with the location's zone is 200 (old web)", async () => {
    await as(api().put('/api/v1/locations/schedule'), mainId)
      .send({ timezone: 'America/Bogota', ranges: [] })
      .expect(200);
  });

  it('PUT schedule with another zone is 400 and changes nothing', async () => {
    await as(api().put('/api/v1/locations/schedule'), mainId)
      .send({ ranges: WEEK })
      .expect(200);
    const res = await as(api().put('/api/v1/locations/schedule'), mainId)
      .send({ timezone: 'Europe/Madrid', ranges: [] })
      .expect(400);
    expect((res.body as { message: string }).message).toBe(MOVED);
    const after = await as(
      api().get('/api/v1/locations/schedule'),
      mainId,
    ).expect(200);
    expect(after.body).toEqual({ timezone: 'America/Bogota', ranges: WEEK });
    expect(
      (
        await raw.location.findUniqueOrThrow({
          where: { id: mainId },
          select: { timeZone: true },
        })
      ).timeZone,
    ).toBe('America/Bogota');
  });

  it('creating a location writes location_schedules.timezone equal to its zone', async () => {
    const res = await as(api().post('/api/v1/locations'))
      .send(locationBody(REGIONAL_TOKYO_FIXTURE, { name: 'Tokio' }))
      .expect(201);
    const tokyoId = (res.body as { id: string }).id;
    expect(await legacyZone(tokyoId)).toBe('Asia/Tokyo');
  });

  it('GET schedule returns the location zone, never the legacy column', async () => {
    const tokyoId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId, name: 'Tokio' },
        select: { id: true },
      })
    ).id;
    // Una réplica antigua (o un dato viejo) dejó otra zona en el horario.
    await raw.locationSchedule.updateMany({
      where: { locationId: tokyoId },
      data: { timezone: 'America/Bogota' },
    });
    const res = await as(
      api().get('/api/v1/locations/schedule'),
      tokyoId,
    ).expect(200);
    expect((res.body as { timezone: string }).timezone).toBe('Asia/Tokyo');

    // Guardar el horario vuelve a alinear la columna legada (R20).
    await as(api().put('/api/v1/locations/schedule'), tokyoId)
      .send({ ranges: WEEK })
      .expect(200);
    expect(await legacyZone(tokyoId)).toBe('Asia/Tokyo');
  });

  it('una sede sin zona (réplica antigua sin barrer): el PUT es 409 LOCATION_TIMEZONE_REQUIRED, y con timezone 400', async () => {
    const legacyId = await legacyLocationInsert(
      raw,
      clinic.tenantId,
      'Antigua',
    );
    const res = await as(api().put('/api/v1/locations/schedule'), legacyId)
      .send({ ranges: WEEK })
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'LOCATION_TIMEZONE_REQUIRED',
      locationId: legacyId,
    });
    await as(api().put('/api/v1/locations/schedule'), legacyId)
      .send({ timezone: 'America/Bogota', ranges: WEEK })
      .expect(400);
    expect(
      await raw.locationSchedule.count({ where: { locationId: legacyId } }),
    ).toBe(0);
  });
});
