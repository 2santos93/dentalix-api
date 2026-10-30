import { INestApplication } from '@nestjs/common';
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
  ExchangeRateUnavailableError,
  type ExchangeRatesResult,
} from '../src/modules/exchange/domain/ports/exchange-rate-provider.port';
import { DEFAULT_PROVIDER_RATES_LIMITS } from '../src/modules/exchange/application/provider-rates-gate';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import { REGIONAL_BOGOTA_FIXTURE } from './support/location-fixtures';

// SEC-054: la cuota del proveedor de tasas es una para toda la plataforma.
// Con un doble del proveedor que cuenta las llamadas (nunca sale a la red):
// un usuario que pide 50 días antiguos distintos se queda en el presupuesto de
// su clínica (30 por hora, el de por defecto) y recibe 429 sin más llamadas;
// las fechas imposibles o fuera de la ventana de la clínica son 400 sin
// llamar; un día que el proveedor no tiene no se vuelve a pedir (caché
// negativa); una clínica en MANUAL nunca llama por los días de su tasa
// manual (un día anterior al cambio sí, con el mismo presupuesto). `raw` (DIRECT_URL) solo
// adelanta el alta de las clínicas, pasa una a MANUAL y limpia snapshots.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const CLINIC_LIMIT = DEFAULT_PROVIDER_RATES_LIMITS.clinic.limit;
// 50 días de enero y febrero de 2025: dentro de la ventana (las clínicas se
// dan de alta «el» 2024-10-01) y sin snapshot de ninguna otra suite.
const OLD_DAYS = Array.from({ length: 50 }, (_, i) =>
  addCivilDays('2025-01-01', i),
);
const FAILING_DAY = '2025-03-15';
const MANUAL_PAST_DAY = '2025-03-20';
const ALL_DAYS = [...OLD_DAYS, FAILING_DAY, MANUAL_PAST_DAY, '2025-04-01'];

interface ErrorBody {
  statusCode: number;
  code?: string;
  message: string | string[];
}

describe('Cuota del proveedor de tasas (e2e, SEC-054)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let manual: Clinic;
  const fetchRates = jest.fn((date: string): Promise<ExchangeRatesResult> =>
    date === FAILING_DAY
      ? Promise.reject(
          new ExchangeRateUnavailableError(
            'Open Exchange Rates returned 400 for date 2025-03-15',
          ),
        )
      : Promise.resolve({
          base: 'USD',
          rates: { COP: 4000 + Number(date.slice(-2)) },
        }),
  );

  const today = () => civilDateIn(new Date(), REGIONAL_BOGOTA_FIXTURE.timeZone);
  const get = (clinic: Clinic, path: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/exchange/${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);
  const rates = (clinic: Clinic, date: string) =>
    get(clinic, `rates?date=${date}`);
  const convert = (clinic: Clinic, date: string) =>
    get(clinic, `convert?amount=100&from=USD&to=COP&date=${date}`);

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder
          .overrideProvider(EXCHANGE_RATE_PROVIDER)
          .useValue({ fetchRates }),
    });
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: ALL_DAYS } },
    });
    a = await registerClinic(app, 'sec054-a');
    b = await registerClinic(app, 'sec054-b');
    manual = await registerClinic(app, 'sec054-manual');
    // `tenants` es global (sin RLS): el alta, hace dos años.
    await raw.tenant.updateMany({
      where: { id: { in: [a.tenantId, b.tenantId, manual.tenantId] } },
      data: { createdAt: new Date('2024-10-01T12:00:00.000Z') },
    });
    await raw.tenant.update({
      where: { id: manual.tenantId },
      data: {
        exchangeRateSource: 'MANUAL',
        manualExchangeRatesSince: new Date(`${today()}T00:00:00.000Z`),
      },
    });
  });

  afterAll(async () => {
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: ALL_DAYS } },
    });
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  beforeEach(() => fetchRates.mockClear());

  it.each(['2026-02-30', '2026-13-01', '2025-02-29'])(
    'una fecha imposible (%s) es 400 en español en las dos rutas, sin llamar',
    async (date) => {
      for (const res of [await rates(a, date), await convert(a, date)]) {
        expect(res.status).toBe(400);
        expect((res.body as ErrorBody).message).toEqual([
          'date debe ser un día que exista, con el formato AAAA-MM-DD.',
        ]);
      }
      expect(fetchRates).not.toHaveBeenCalled();
    },
  );

  it('fuera de la ventana de la clínica (antes del alta, o después de hoy): 400 sin llamar', async () => {
    const tomorrow = addCivilDays(today(), 1);
    for (const date of ['2024-09-30', '1999-01-04', tomorrow, '2099-01-01']) {
      for (const res of [await rates(a, date), await convert(a, date)]) {
        expect(res.status).toBe(400);
        const body = res.body as ErrorBody & { first: string; today: string };
        expect(body.code).toBe('EXCHANGE_RATE_DATE_OUT_OF_RANGE');
        expect(body.first).toBe('2024-10-01');
        expect(body.today).toBe(today());
        expect(body.message).toContain('solo se piden al proveedor los días');
      }
    }
    expect(fetchRates).not.toHaveBeenCalled();
  });

  it('caché negativa: un día que el proveedor no tiene no se vuelve a pedir, y el error no trae su respuesta', async () => {
    for (let i = 0; i < 3; i += 1) {
      for (const res of [
        await rates(b, FAILING_DAY),
        await convert(a, FAILING_DAY),
      ]) {
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({
          code: 'EXCHANGE_RATE_UNAVAILABLE',
          message:
            'No pudimos obtener las tasas de ese día. Inténtalo de nuevo más tarde.',
        });
        expect(JSON.stringify(res.body)).not.toContain('Open Exchange Rates');
      }
    }
    expect(fetchRates).toHaveBeenCalledTimes(1);
  });

  it('50 fechas antiguas distintas: 429 en español al pasar el presupuesto de la clínica, sin más llamadas', async () => {
    // A no gastó nada en el día que falló: lo pidió B y A lo encontró en la
    // caché negativa.
    const budget = CLINIC_LIMIT;
    const statuses: number[] = [];
    let lastTooMany: request.Response | undefined;
    for (const date of OLD_DAYS) {
      const res = await rates(a, date);
      statuses.push(res.status);
      if (res.status === 429) lastTooMany = res;
    }
    expect(statuses.slice(0, budget)).toEqual(Array(budget).fill(200));
    expect(statuses.slice(budget)).toEqual(
      Array(OLD_DAYS.length - budget).fill(429),
    );
    expect(fetchRates).toHaveBeenCalledTimes(budget);

    expect(lastTooMany!.body).toMatchObject({
      statusCode: 429,
      code: 'EXCHANGE_RATE_BUDGET_EXCEEDED',
    });
    expect((lastTooMany!.body as ErrorBody).message).toMatch(
      /^La clínica consultó demasiados días sin tasa guardada\. Intenta de nuevo en \d+ minutos\.$/,
    );
    const retryAfter = Number(lastTooMany!.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60 * 60);

    // /convert comparte el presupuesto; los días ya guardados siguen saliendo.
    expect((await convert(a, OLD_DAYS[49])).status).toBe(429);
    const cached = await convert(a, OLD_DAYS[0]);
    expect(cached.status).toBe(200);
    expect(cached.body).toMatchObject({ result: 400100 });
    expect(fetchRates).toHaveBeenCalledTimes(budget);

    // Otra clínica tiene su propio presupuesto.
    expect((await rates(b, '2025-04-01')).status).toBe(200);
    expect(fetchRates).toHaveBeenCalledTimes(budget + 1);
  });

  it('una clínica en MANUAL nunca llama al proveedor por los días de su tasa manual', async () => {
    const todays = await rates(manual, today());
    expect(todays.status).toBe(200);
    expect(todays.body).toEqual({ base: 'USD', source: 'MANUAL', rates: {} });
    // El día anterior al cambio que ya está guardado se lee de la caché.
    expect((await rates(manual, OLD_DAYS[0])).body).toMatchObject({
      source: 'AUTOMATIC',
      rates: { COP: 4001 },
    });
    expect(fetchRates).not.toHaveBeenCalled();
  });

  // Revisión de SEC-054: un día anterior al cambio sin guardar sigue con la
  // automática (DX-374) y se pide una vez, con el presupuesto de la clínica.
  it('con MANUAL, un día anterior al cambio sin guardar se pide al proveedor una vez', async () => {
    for (let i = 0; i < 2; i += 1) {
      const past = await rates(manual, MANUAL_PAST_DAY);
      expect(past.status).toBe(200);
      expect(past.body).toEqual({
        base: 'USD',
        source: 'AUTOMATIC',
        rates: { COP: 4020 },
      });
    }
    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(fetchRates).toHaveBeenCalledWith(MANUAL_PAST_DAY);
  });
});
