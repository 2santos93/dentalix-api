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
  REGIONAL_NEW_YORK_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  locationBody,
} from './support/location-fixtures';

// GLOBAL-G1 (DX-314, R4): el horario de una sede se lee en la zona de la SEDE
// (`Location.timeZone`), no en la columna legada del horario ni en la del
// país. Una sede en Tokio con el horario por defecto (lun–vie 9–13 y 15–19)
// admite las 10:00 de Tokio y rechaza las 14:00 de Tokio.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

describe('Horario de atención en la zona de la sede (e2e, G1)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let tokyoId: string;
  let patientId: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test): request.Test =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);

  const book = (start: string, end: string) =>
    as(api().post('/api/v1/appointments'))
      .set('X-Location-Id', tokyoId)
      .send({ patientId, providerId: clinic.adminUserId, start, end });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'g1-hours-e2e');
    const tokyo = await as(api().post('/api/v1/locations'))
      .send(locationBody(REGIONAL_TOKYO_FIXTURE, { name: 'Tokio' }))
      .expect(201);
    tokyoId = (tokyo.body as { id: string }).id;
    // La columna legada del horario dice otra cosa: el código nuevo no la lee.
    await raw.locationSchedule.updateMany({
      where: { locationId: tokyoId },
      data: { timezone: 'America/New_York' },
    });
    const patient = await as(api().post('/api/v1/patients'))
      .send({
        firstName: 'Ana',
        lastName: 'Paciente',
        docType: 'NATIONAL_ID',
        docNumber: '3140001',
        sex: 'F',
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  // El próximo lunes: una fecha fija caduca y la cita deja de ser futura.
  const monday = (() => {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + ((8 - day.getUTCDay()) % 7 || 7));
    return day.toISOString().slice(0, 10);
  })();

  // 10:00 en Tokio (UTC+9) = 01:00Z, que en la zona de la columna legada aún
  // es domingo por la noche: fuera de horario si se leyera esa zona.
  it('una cita a las 10:00 de Tokio cabe en el horario de la sede de Tokio', async () => {
    await book(`${monday}T01:00:00.000Z`, `${monday}T01:30:00.000Z`).expect(
      201,
    );
  });

  // 14:00 en Tokio = 05:00Z: el cierre de mediodía de la sede. 422 desde
  // DX-121 (la petición es válida, pero ese hueco no existe).
  it('appointment outside opening hours at a Tokyo location is rejected (422 since DX-121)', async () => {
    const res = await book(
      `${monday}T05:00:00.000Z`,
      `${monday}T05:30:00.000Z`,
    ).expect(422);
    expect((res.body as { message: string }).message).toMatch(
      /Fuera del horario de atención/,
    );
  });

  it('GET del horario de la sede devuelve la zona de la sede', async () => {
    const res = await as(api().get('/api/v1/locations/schedule'))
      .set('X-Location-Id', tokyoId)
      .expect(200);
    expect((res.body as { timezone: string }).timezone).toBe('Asia/Tokyo');
  });

  // DX-354: las horas del mensaje salen con el reloj de la sede, no en 24 h fijas.
  describe('el mensaje de horario con el reloj de la sede (DX-354)', () => {
    let newYorkId: string;
    const bookAtNewYork = () =>
      as(api().post('/api/v1/appointments'))
        .set('X-Location-Id', newYorkId)
        // 13:30–14:30 EST/EDT según la fecha: cae siempre en el cierre de mediodía.
        .send({
          patientId,
          providerId: clinic.adminUserId,
          start: `${monday}T18:30:00.000Z`,
          end: `${monday}T19:00:00.000Z`,
        });

    beforeAll(async () => {
      const res = await as(api().post('/api/v1/locations'))
        .send(locationBody(REGIONAL_NEW_YORK_FIXTURE, { name: 'Nueva York' }))
        .expect(201);
      newYorkId = (res.body as { id: string }).id;
    });

    it('sede h12: el 422 dice las horas en 12 h', async () => {
      const res = await bookAtNewYork().expect(422);
      expect((res.body as { message: string }).message).toBe(
        'Fuera del horario de atención (lunes: 9:00 a. m.–1:00 p. m., 3:00 p. m.–7:00 p. m.)',
      );
    });

    it('sede sin reloj: 409 LOCATION_LOCALE_REQUIRED al rechazar por horario', async () => {
      await raw.location.update({
        where: { id: newYorkId },
        data: { hourCycle: null },
      });
      try {
        const res = await bookAtNewYork().expect(409);
        expect((res.body as { code: string }).code).toBe(
          'LOCATION_LOCALE_REQUIRED',
        );
      } finally {
        await raw.location.update({
          where: { id: newYorkId },
          data: { hourCycle: 'h12' },
        });
      }
    });
  });
});
