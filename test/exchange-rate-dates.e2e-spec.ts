import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { App } from 'supertest/types';
import { Prisma, PrismaClient } from '@prisma/client';
import { createE2eApp } from './support/create-e2e-app';
import {
  registerClinic,
  resetDatabase,
  type Clinic,
} from './support/e2e-fixtures';
import {
  EXCHANGE_RATE_PROVIDER,
  type ExchangeRatesResult,
} from '../src/modules/exchange/domain/ports/exchange-rate-provider.port';
import {
  addCivilDays,
  civilDateIn,
  parseCivilDate,
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../src/shared/time/civil-day';
import {
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
} from './support/location-fixtures';

// BE-049 (DX-383): `GET /exchange/rates` y `/convert` solo admiten días que
// existen, entre PERIOD_DAY_MIN y PERIOD_DAY_MAX y no posteriores a hoy en la
// zona de las sedes de la clínica, con las dos fuentes. El proveedor es un
// doble que FALLA el test si se le pide un día que no debería llegarle (y
// nunca sale a la red). `raw` (DIRECT_URL) solo adelanta el alta de las
// clínicas (`tenants`, global) y siembra o limpia snapshots (globales).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SETTINGS = '/api/v1/exchange/settings';
const MANUAL_RATES = '/api/v1/exchange/manual-rates';
// Días que ninguna otra suite siembra.
const CACHED_DAY = '2025-05-05';
const MISSING_DAY = '2025-05-06';
const IMPOSSIBLE = ['2026-02-30', '2026-13-01'];
const OUT_OF_RANGE = ['1900-01-01', '2999-12-31'];
const INVALID_MESSAGE =
  'date debe ser un día que exista, con el formato AAAA-MM-DD.';
const OUT_OF_RANGE_MESSAGE =
  'date tiene que ser un día entre el 2000-01-01 y el 2100-12-31.';

const todayIn = (timeZone: string) => civilDateIn(new Date(), timeZone);
const bogotaToday = () => todayIn(REGIONAL_BOGOTA_FIXTURE.timeZone);
const tokyoToday = () => todayIn(REGIONAL_TOKYO_FIXTURE.timeZone);

/**
 * Un día que el proveedor puede recibir: existe, está en el rango y ya ha
 * llegado en alguna zona (Kiritimati, UTC+14, va por delante de todas).
 */
function isProviderDay(date: string): boolean {
  return (
    parseCivilDate(date) !== null &&
    date >= PERIOD_DAY_MIN &&
    date <= PERIOD_DAY_MAX &&
    date <= todayIn('Pacific/Kiritimati')
  );
}

interface ErrorBody {
  statusCode: number;
  code?: string;
  message: string | string[];
  today?: string;
}

describe('Fechas de /exchange/rates y /exchange/convert (e2e, BE-049, DX-383)', () => {
  let app: INestApplication<App>;
  let auto: Clinic;
  let manual: Clinic;
  let tokyo: Clinic;
  const badCalls: string[] = [];
  const fetchRates = jest.fn((date: string): Promise<ExchangeRatesResult> => {
    if (!isProviderDay(date)) {
      badCalls.push(date);
      return Promise.reject(
        new Error(`El proveedor no debería recibir ${date}`),
      );
    }
    return Promise.resolve({
      base: 'USD',
      rates: { COP: 4000 + Number(date.slice(-2)) },
    });
  });

  const as = (clinic: Clinic, req: request.Test) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);
  const get = (clinic: Clinic, path: string) =>
    as(clinic, request(app.getHttpServer()).get(`/api/v1/exchange/${path}`));
  const rates = (clinic: Clinic, date: string) =>
    get(clinic, `rates?date=${date}`);
  const convert = (clinic: Clinic, date: string) =>
    get(clinic, `convert?amount=100&from=USD&to=COP&date=${date}`);
  const both = async (clinic: Clinic, date: string) => [
    await rates(clinic, date),
    await convert(clinic, date),
  ];
  // Snapshots globales que esta suite puede crear o sembrar.
  const touchedDays = () => [
    CACHED_DAY,
    MISSING_DAY,
    bogotaToday(),
    addCivilDays(bogotaToday(), 1),
    tokyoToday(),
    addCivilDays(tokyoToday(), 1),
  ];

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder
          .overrideProvider(EXCHANGE_RATE_PROVIDER)
          .useValue({ fetchRates }),
    });
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: touchedDays() } },
    });
    await raw.exchangeRateSnapshot.create({
      data: { date: CACHED_DAY, currency: 'COP', rate: 3900 },
    });
    auto = await registerClinic(app, 'dx383-auto');
    manual = await registerClinic(app, 'dx383-manual');
    tokyo = await registerClinic(app, 'dx383-tokyo', REGIONAL_TOKYO_FIXTURE);
    // `tenants` es global (sin RLS): el alta, hace dos años.
    await raw.tenant.updateMany({
      where: { id: { in: [auto.tenantId, manual.tenantId, tokyo.tenantId] } },
      data: { createdAt: new Date('2024-10-01T12:00:00.000Z') },
    });
    await as(manual, request(app.getHttpServer()).put(SETTINGS))
      .send({ source: 'MANUAL' })
      .expect(200);
  });

  afterAll(async () => {
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: touchedDays() } },
    });
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  beforeEach(() => fetchRates.mockClear());
  afterEach(() => {
    // El doble falla el test si se le pidió una fecha inválida.
    expect(badCalls).toEqual([]);
  });

  describe.each([
    ['AUTOMATIC', () => auto],
    ['MANUAL', () => manual],
  ])('con fuente %s', (_source, clinic) => {
    it.each(IMPOSSIBLE)(
      'un día que no existe (%s) es 400 en español, sin llamar al proveedor',
      async (date) => {
        for (const res of await both(clinic(), date)) {
          expect(res.status).toBe(400);
          expect((res.body as ErrorBody).message).toEqual([INVALID_MESSAGE]);
        }
        expect(fetchRates).not.toHaveBeenCalled();
      },
    );

    it.each(OUT_OF_RANGE)(
      'un día fuera del rango (%s) es 400 en español, sin llamar al proveedor',
      async (date) => {
        for (const res of await both(clinic(), date)) {
          expect(res.status).toBe(400);
          expect((res.body as ErrorBody).message).toEqual([
            OUT_OF_RANGE_MESSAGE,
          ]);
        }
        expect(fetchRates).not.toHaveBeenCalled();
      },
    );

    it('mañana en la zona de la sede es 400 EXCHANGE_RATE_DATE_FUTURE, aunque haya snapshot', async () => {
      const today = bogotaToday();
      const tomorrow = addCivilDays(today, 1);
      await raw.exchangeRateSnapshot.upsert({
        where: { date_currency: { date: tomorrow, currency: 'COP' } },
        create: { date: tomorrow, currency: 'COP', rate: 1 },
        update: {},
      });
      for (const res of await both(clinic(), tomorrow)) {
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
          code: 'EXCHANGE_RATE_DATE_FUTURE',
          today,
          message: `Ese día aún no ha llegado en las sedes de la clínica: no tiene tasa. Hoy es ${today}.`,
        });
      }
      expect(fetchRates).not.toHaveBeenCalled();
    });
  });

  it('AUTOMATIC: un día guardado sale de la caché y uno sin guardar del proveedor, como antes', async () => {
    const [cachedRates, cachedConvert] = await both(auto, CACHED_DAY);
    expect(cachedRates.status).toBe(200);
    expect(cachedRates.body).toEqual({
      base: 'USD',
      source: 'AUTOMATIC',
      rates: { COP: 3900 },
    });
    expect(cachedConvert.body).toMatchObject({
      result: 390000,
      rateUsed: 3900,
    });
    expect(fetchRates).not.toHaveBeenCalled();

    const [missRates, missConvert] = await both(auto, MISSING_DAY);
    expect(missRates.status).toBe(200);
    expect(missRates.body).toEqual({
      base: 'USD',
      source: 'AUTOMATIC',
      rates: { COP: 4006 },
    });
    expect(missConvert.body).toMatchObject({ result: 400600 });
    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(fetchRates).toHaveBeenCalledWith(MISSING_DAY);
  });

  it('MANUAL: hoy responde con la tasa registrada, sin llamar al proveedor, como antes', async () => {
    const today = bogotaToday();
    await as(manual, request(app.getHttpServer()).post(MANUAL_RATES))
      .send({ date: today, currency: 'COP', rate: 4100 })
      .expect(201);
    const [todayRates, todayConvert] = await both(manual, today);
    expect(todayRates.status).toBe(200);
    expect(todayRates.body).toEqual({
      base: 'USD',
      source: 'MANUAL',
      rates: { COP: 4100 },
    });
    expect(todayConvert.body).toMatchObject({ result: 410000, rateUsed: 4100 });
    expect(fetchRates).not.toHaveBeenCalled();
  });

  it('Swagger documenta el formato y el rango de `date` en las dos rutas', () => {
    const swagger = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    for (const path of ['/api/v1/exchange/rates', '/api/v1/exchange/convert']) {
      const date = swagger.paths[path].get?.parameters?.find(
        (p) => 'name' in p && p.name === 'date',
      ) as {
        schema?: { format?: string; pattern?: string };
        description?: string;
      };
      expect(date.schema).toMatchObject({
        format: 'date',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      });
      expect(date.description).toContain('entre el 2000-01-01 y el 2100-12-31');
      expect(date.description).toContain('EXCHANGE_RATE_DATE_FUTURE');
    }
  });

  it('«hoy» es el de la zona de la sede: una clínica en Tokio pide su hoy y no su mañana', async () => {
    const today = tokyoToday();
    expect((await rates(tokyo, today)).status).toBe(200);
    const res = await rates(tokyo, addCivilDays(today, 1));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'EXCHANGE_RATE_DATE_FUTURE',
      today,
    });
  });
});
