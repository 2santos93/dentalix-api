import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  Prisma,
  PrismaClient,
  Sex,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { pinCatalogCurrency } from './support/catalog-currency';
import { SEDE_FIXTURE_ZONE } from './support/sede-clock';
import {
  addCivilDays,
  civilDateIn,
  civilNoonIn,
  civilWeekday,
} from '../src/shared/time/civil-day';
import { EXCHANGE_RATE_CLOCK } from '../src/modules/exchange/application/use-cases/manual-exchange-rates.use-cases';
import { EXCHANGE_RATE_SETTINGS_FORBIDDEN_MESSAGE } from '../src/modules/exchange/presentation/exchange-settings.controller';
import { JobRegistry } from '../src/modules/jobs/application/job-registry';
import { BCV_REFRESH_JOB } from '../src/modules/exchange/application/jobs/bcv-rate.jobs';

// DX-585 por HTTP: la fuente «BCV oficial». Un servidor falso en 127.0.0.1
// hace de BCV (BCV_BASE_URL) y de respaldo: nunca se consulta la red real.
// EXCHANGE_APP_ID está vacío en .env.test: el proveedor automático no se
// llama (VES y EUR salen del BCV).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

/** El último domingo que ya pasó hace al menos 2 días en la sede (Caracas). */
function pastSunday(): string {
  let day = addCivilDays(civilDateIn(new Date(), SEDE_FIXTURE_ZONE), -2);
  while (civilWeekday(day) !== 0) day = addCivilDays(day, -1);
  return day;
}

const SUNDAY = pastSunday();
const SATURDAY = addCivilDays(SUNDAY, -1);
const FRIDAY = addCivilDays(SUNDAY, -2);
const MONDAY = addCivilDays(SUNDAY, 1);
/** «Ahora» de la API: el domingo a mediodía en la sede. */
const NOW = civilNoonIn(SUNDAY, SEDE_FIXTURE_ZONE);
const FRIDAY_FETCHED = new Date(`${addCivilDays(FRIDAY, -1)}T21:00:00.000Z`);
const MONDAY_FETCHED = new Date(`${FRIDAY}T20:00:00.000Z`);
/** Fecha valor que publica el BCV falso del trabajo: lejos de las sembradas. */
const JOB_DAY = addCivilDays(SUNDAY, -30);

const SETTINGS = '/api/v1/exchange/settings';
const HEADER = '/api/v1/exchange/header';
const RATES = '/api/v1/exchange/rates';

const FIXTURE_PAGE = readFileSync(
  join(
    __dirname,
    '..',
    'src/modules/exchange/infrastructure/providers/__fixtures__/bcv-home-2026-11-21.html',
  ),
  'utf8',
);
const PAGE = FIXTURE_PAGE.replace(
  'content="2026-11-24T00:00:00-04:00"',
  `content="${JOB_DAY}T00:00:00-04:00"`,
);

interface RatesBody {
  source: string;
  rates: Record<string, number>;
  rateDate: string;
  bcv?: { valueDate: string; fetchedAt: string } | null;
}

describe('Fuente de tasa BCV oficial (e2e, DX-585)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let plan: string;
  let dentist: string;
  let stub: Server;
  let stubRoutes: Record<string, { status: number; body: string }>;
  const savedEnv = process.env.BCV_BASE_URL;
  const savedFallbackEnv = process.env.BCV_FALLBACK_BASE_URL;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const sourceEvents = () =>
    raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        metadata: { path: ['reason'], equals: 'EXCHANGE_RATE_SOURCE' },
      },
      orderBy: { occurredAt: 'asc' },
    });
  const rates = async (clinic: Clinic, query: string) =>
    (await as(api().get(`${RATES}?${query}`), clinic).expect(200))
      .body as RatesBody;

  beforeAll(async () => {
    stub = createServer((req, res) => {
      const route = stubRoutes[req.url ?? ''] ?? { status: 404, body: '' };
      res.writeHead(route.status, { 'content-type': 'text/html' });
      res.end(route.body);
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    process.env.BCV_BASE_URL = `${base}/bcv`;
    process.env.BCV_FALLBACK_BASE_URL = `${base}/fallback`;

    app = await createE2eApp({
      override: (builder) =>
        builder.overrideProvider(EXCHANGE_RATE_CLOCK).useValue(() => NOW),
    });
    await resetDatabase(raw);
    await raw.bcvRateSnapshot.createMany({
      data: [
        {
          valueDate: new Date(`${FRIDAY}T00:00:00.000Z`),
          usdVes: new Prisma.Decimal('918.7662'),
          eurVes: new Prisma.Decimal('1011.17949056'),
          fetchedAt: FRIDAY_FETCHED,
          origin: 'BCV',
        },
        // La del lunes ya publicada el viernes: no rige el fin de semana.
        {
          valueDate: new Date(`${MONDAY}T00:00:00.000Z`),
          usdVes: new Prisma.Decimal('925'),
          eurVes: new Prisma.Decimal('1020'),
          fetchedAt: MONDAY_FETCHED,
          origin: 'BCV',
        },
      ],
    });
    a = await registerClinic(app, 'dx585-a');
    b = await registerClinic(app, 'dx585-b');
    dentist = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.DENTIST)).email,
    );

    const patient = (
      await as(api().post('/api/v1/patients'), a)
        .send({
          firstName: 'Bea',
          lastName: 'Bolívar',
          docType: 'NATIONAL_ID',
          docNumber: 'DX585-E2E',
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    await pinCatalogCurrency(raw, a.tenantId, 'USD');
    const item = (
      await as(api().post('/api/v1/catalog/items'), a)
        .send({
          code: 'DX585-E2E',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 1000,
        })
        .expect(201)
    ).body as { id: string };
    plan = (
      (
        await as(
          api().post(`/api/v1/patients/${patient.id}/treatment-plans`),
          a,
        )
          .send({ notes: 'Plan DX-585', currency: 'USD' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const planItem = (
      await as(api().post(`/api/v1/treatment-plans/${plan}/items`), a)
        .send({ toothNumber: '11', catalogItemId: item.id })
        .expect(201)
    ).body as { id: string };
    await as(
      api().patch(`/api/v1/treatment-plans/${plan}/items/${planItem.id}`),
      a,
    )
      .send({ status: 'DONE' })
      .expect(200);
  }, 120_000);

  afterAll(async () => {
    await resetDatabase(raw);
    await app?.close();
    await raw.$disconnect();
    stub.closeAllConnections();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    if (savedEnv === undefined) delete process.env.BCV_BASE_URL;
    else process.env.BCV_BASE_URL = savedEnv;
    if (savedFallbackEnv === undefined)
      delete process.env.BCV_FALLBACK_BASE_URL;
    else process.env.BCV_FALLBACK_BASE_URL = savedFallbackEnv;
  });

  it('solo ADMIN elige BCV: el DENTIST recibe 403 y no queda evento', async () => {
    const res = await as(api().put(SETTINGS), a, dentist)
      .send({ source: 'BCV' })
      .expect(403);
    expect((res.body as { message: string }).message).toBe(
      EXCHANGE_RATE_SETTINGS_FORBIDDEN_MESSAGE,
    );
    expect(await sourceEvents()).toHaveLength(0);
  });

  it('una fuente desconocida es 400 en español con las tres opciones', async () => {
    const res = await as(api().put(SETTINGS), a)
      .send({ source: 'PARALELO' })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain(
      'Elige de dónde sale la tasa: automática, manual o BCV oficial.',
    );
  });

  it('el ADMIN pasa a BCV: manualSince null y evento EXCHANGE_RATE_SOURCE con el antes y el después', async () => {
    const res = await as(api().put(SETTINGS), a)
      .send({ source: 'BCV' })
      .expect(200);
    expect(res.body).toMatchObject({ source: 'BCV', manualSince: null });
    await expect(as(api().get(SETTINGS), a).expect(200)).resolves.toMatchObject(
      { body: { source: 'BCV', manualSince: null } },
    );
    const events = await sourceEvents();
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      reason: 'EXCHANGE_RATE_SOURCE',
      statusChange: { from: 'AUTOMATIC', to: 'BCV' },
    });
  });

  it('GET /exchange/rates el domingo: VES y EUR del BCV del viernes (último día hábil), con su fecha valor', async () => {
    const body = await rates(a, `date=${SUNDAY}&currencies=VES,EUR`);
    expect(body).toEqual({
      base: 'USD',
      source: 'BCV',
      rates: { VES: 918.7662, EUR: 0.90860842 },
      rateDate: SUNDAY,
      bcv: { valueDate: FRIDAY, fetchedAt: FRIDAY_FETCHED.toISOString() },
    });
    await expect(
      rates(a, `date=${SATURDAY}&currencies=VES`),
    ).resolves.toMatchObject({ bcv: { valueDate: FRIDAY } });
  });

  it('otra clínica (AUTOMATIC) no ve la tasa BCV: su fuente es la suya', async () => {
    const res = await as(
      api().get(`${RATES}?date=${SUNDAY}&currencies=VES`),
      b,
    );
    // Sin EXCHANGE_APP_ID el proveedor no da tasa (o el día cae antes del
    // alta de B): nunca la del BCV de A.
    if (res.status === 200) {
      expect((res.body as RatesBody).source).toBe('AUTOMATIC');
    } else {
      expect([400, 503]).toContain(res.status);
    }
  });

  it('GET /exchange/header: «1 USD = 918,7662 Bs.» con fuente BCV, fecha valor y hora de consulta', async () => {
    await as(api().put(SETTINGS), a)
      .send({ acceptedCurrencies: ['USD', 'VES', 'EUR'] })
      .expect(200);
    const res = await as(api().get(HEADER), a, dentist).expect(200);
    const body = res.body as {
      visible: boolean;
      reference: string;
      rates: {
        currency: string;
        perReference: number | null;
        source: string;
        date: string;
        fetchedAt: string | null;
        valueDate: string | null;
      }[];
    };
    expect(body.visible).toBe(true);
    expect(body.reference).toBe('VES');
    expect(body.rates[0]).toEqual({
      currency: 'USD',
      perReference: 918.7662,
      label: null,
      source: 'BCV',
      date: SUNDAY,
      fetchedAt: FRIDAY_FETCHED.toISOString(),
      valueDate: FRIDAY,
    });
    expect(body.rates[1]).toMatchObject({
      currency: 'EUR',
      source: 'BCV',
      valueDate: FRIDAY,
    });
    expect(body.rates[1].perReference).toBeCloseTo(1011.1795, 3);
  });

  it('un abono en VES de un plan en USD congela la tasa con fuente BCV', async () => {
    const res = await as(
      api().post(`/api/v1/treatment-plans/${plan}/payments`),
      a,
    )
      .send({
        amount: 91876.62,
        currency: 'VES',
        paidAt: new Date(NOW.getTime() - 60_000).toISOString(),
        method: 'CASH',
      })
      .expect(201);
    expect(res.body).toMatchObject({
      exchangeRateStatus: 'FROZEN',
      exchangeRateCurrency: 'USD',
      frozenRate: {
        currency: 'USD',
        fromPerBase: 918.7662,
        toPerBase: 1,
        source: 'BCV',
        date: SUNDAY,
      },
    });
    const stored = await raw.payment.findUniqueOrThrow({
      where: { id: (res.body as { id: string }).id },
      select: { exchangeRateSource: true },
    });
    expect(stored.exchangeRateSource).toBe('BCV');
    const balance = await as(
      api().get(`/api/v1/treatment-plans/${plan}/balance`),
      a,
    ).expect(200);
    expect(balance.body).toMatchObject({ paid: 100 });
  });

  it('volver a AUTOMATIC deja el evento BCV → AUTOMATIC y el abono conserva su tasa BCV', async () => {
    await as(api().put(SETTINGS), a).send({ source: 'AUTOMATIC' }).expect(200);
    const events = await sourceEvents();
    expect(events.at(-1)?.metadata).toMatchObject({
      statusChange: { from: 'BCV', to: 'AUTOMATIC' },
    });
    const payment = await raw.payment.findFirstOrThrow({
      where: { treatmentPlanId: plan },
      select: { exchangeRateSource: true },
    });
    expect(payment.exchangeRateSource).toBe('BCV');
    await as(api().put(SETTINGS), a).send({ source: 'BCV' }).expect(200);
  });

  describe('trabajo exchange.bcv-refresh contra un BCV falso', () => {
    const runJob = () =>
      app.get(JobRegistry).get(BCV_REFRESH_JOB)!.handle(
        {},
        {
          jobId: 'e2e',
          attempt: 1,
          maxAttempts: 3,
          tenantId: null,
          signal: new AbortController().signal,
        },
      );
    const stored = (valueDate: string) =>
      raw.bcvRateSnapshot.findUnique({
        where: { valueDate: new Date(`${valueDate}T00:00:00.000Z`) },
      });

    beforeEach(async () => {
      await raw.bcvRateSnapshot.deleteMany({
        where: { valueDate: new Date(`${JOB_DAY}T00:00:00.000Z`) },
      });
    });

    it('lee la portada (fixture) y guarda la tasa por su fecha valor; repetir no cambia nada', async () => {
      stubRoutes = { '/bcv/': { status: 200, body: PAGE } };
      await runJob();
      const row = await stored(JOB_DAY);
      expect(row).toMatchObject({ origin: 'BCV', fetchedAt: NOW });
      expect(row?.usdVes.toString()).toBe('919.8227');
      expect(row?.eurVes.toString()).toBe('1011.17949056');
      await runJob();
      await expect(raw.bcvRateSnapshot.count()).resolves.toBe(3);
    });

    it('si el BCV falla, usa el respaldo (origin FALLBACK)', async () => {
      stubRoutes = {
        '/bcv/': { status: 500, body: 'caído' },
        '/fallback/v1/dolares/oficial': {
          status: 200,
          body: JSON.stringify({
            fuente: 'oficial',
            promedio: 919.5,
            fechaActualizacion: `${JOB_DAY}T00:00:00-04:00`,
          }),
        },
        '/fallback/v1/euros': {
          status: 200,
          body: JSON.stringify([
            {
              fuente: 'oficial',
              promedio: 1011.2,
              fechaActualizacion: `${JOB_DAY}T00:00:00-04:00`,
            },
          ]),
        },
      };
      await runJob();
      await expect(stored(JOB_DAY)).resolves.toMatchObject({
        origin: 'FALLBACK',
      });
    });

    it('si los dos fallan, el trabajo falla (reintenta) y no guarda nada', async () => {
      stubRoutes = { '/bcv/': { status: 500, body: 'caído' } };
      await expect(runJob()).rejects.toThrow(/^Sin tasa del BCV/);
      await expect(stored(JOB_DAY)).resolves.toBeNull();
    });
  });
});
