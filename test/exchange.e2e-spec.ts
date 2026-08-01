import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para seed/cleanup en
// beforeAll/afterAll — usa DIRECT_URL (rol owner, superuser). Ver
// patients.e2e-spec.ts para el mismo patrón. `exchange_rate_snapshots` no
// tiene RLS (es tabla de referencia global, no de tenant), así que en teoría
// una conexión app también podría leerla/escribirla, pero seguimos la misma
// convención de seed/cleanup admin que el resto de la suite e2e.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface RegisterResponseBody {
  tenantId: string;
  userId: string;
}

interface LoginResponseBody {
  accessToken: string;
  refreshToken: string;
}

interface RatesResponseBody {
  base: string;
  rates: Record<string, number>;
}

interface ConvertResponseBody {
  amount: number;
  from: string;
  to: string;
  date: string;
  result: number;
  rateUsed: number;
}

// The date this suite seeds a snapshot for. EXCHANGE_APP_ID is blank in
// .env.test (see .env.test), so if a test ever fell through to the provider
// it would throw ("EXCHANGE_APP_ID is not set") instead of silently hitting
// the network — every assertion below must hit the DB cache, never that path.
const RATE_DATE = '2026-07-01';

describe('Exchange (e2e)', () => {
  let app: INestApplication<App>;
  let accessToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    // FK-safe order, same as patients.e2e-spec.ts.
    // tooth_records referencia patients (y plan items): marcar un ítem de plan
    // como DONE crea un ToothRecord, así que se borran ANTES o el delete de
    // patients falla por FK y hace reventar el afterAll (contaminando las
    // suites siguientes).
    await raw.toothRecord.deleteMany();
    await raw.patient.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
    await raw.exchangeRateSnapshot.deleteMany({ where: { date: RATE_DATE } });

    // Seed the snapshot directly via DIRECT_URL so GetRatesForDateUseCase's
    // cache-then-fetch finds rows for RATE_DATE and returns immediately
    // (cache hit) — it never calls OpenExchangeRatesProvider.fetchRates, so
    // this suite needs no network access and no real EXCHANGE_APP_ID.
    await raw.exchangeRateSnapshot.createMany({
      data: [
        { date: RATE_DATE, currency: 'COP', rate: 4000 },
        { date: RATE_DATE, currency: 'EUR', rate: 0.92 },
      ],
    });

    // Auth only: exchange is not tenant-scoped, but the controller still
    // requires a valid bearer token (JwtAuthGuard) — register+login once for
    // the whole suite, same flow as patients.e2e-spec.ts.
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        clinicName: 'Clinica Exchange',
        subdomain: 'clinica-exchange',
        email: 'owner@clinica-exchange.com',
        password: 'S3cret!!',
        fullName: 'Dr. Owner',
      })
      .expect(201);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor('clinica-exchange'))
      .send({
        email: 'owner@clinica-exchange.com',
        password: 'S3cret!!',
      })
      .expect(201);
    accessToken = (login.body as LoginResponseBody).accessToken;
  });

  afterAll(async () => {
    // tooth_records referencia patients (y plan items): marcar un ítem de plan
    // como DONE crea un ToothRecord, así que se borran ANTES o el delete de
    // patients falla por FK y hace reventar el afterAll (contaminando las
    // suites siguientes).
    await raw.toothRecord.deleteMany();
    await raw.exchangeRateSnapshot.deleteMany({ where: { date: RATE_DATE } });
    await raw.patient.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
    await app.close();
    await raw.$disconnect();
  });

  it('GET /exchange/rates returns the seeded snapshot (cache hit)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/exchange/rates?date=${RATE_DATE}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const body = res.body as RatesResponseBody;
    expect(body).toEqual({ base: 'USD', rates: { COP: 4000, EUR: 0.92 } });
  });

  it('GET /exchange/convert converts USD -> COP using the seeded rate', async () => {
    const res = await request(app.getHttpServer())
      .get(
        `/api/v1/exchange/convert?amount=100&from=USD&to=COP&date=${RATE_DATE}`,
      )
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const body = res.body as ConvertResponseBody;
    expect(body.result).toBe(400000);
    expect(body.from).toBe('USD');
    expect(body.to).toBe('COP');
  });

  it('GET /exchange/convert converts COP -> USD using the seeded rate', async () => {
    const res = await request(app.getHttpServer())
      .get(
        `/api/v1/exchange/convert?amount=400000&from=COP&to=USD&date=${RATE_DATE}`,
      )
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const body = res.body as ConvertResponseBody;
    expect(body.result).toBe(100);
  });

  it('GET /exchange/convert returns the same amount when from === to', async () => {
    const res = await request(app.getHttpServer())
      .get(
        `/api/v1/exchange/convert?amount=250&from=EUR&to=EUR&date=${RATE_DATE}`,
      )
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const body = res.body as ConvertResponseBody;
    expect(body.result).toBe(250);
    expect(body.rateUsed).toBe(1);
  });

  it('GET /exchange/convert rejects an unknown currency for that date with 400', async () => {
    await request(app.getHttpServer())
      .get(
        `/api/v1/exchange/convert?amount=100&from=USD&to=JPY&date=${RATE_DATE}`,
      )
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
  });

  it('GET /exchange/rates rejects an invalid date format with 400', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/exchange/rates?date=2026-7-1')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
  });

  it('GET /exchange/convert rejects an invalid date format with 400', async () => {
    await request(app.getHttpServer())
      .get(
        '/api/v1/exchange/convert?amount=100&from=USD&to=COP&date=not-a-date',
      )
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
  });

  it('rejects requests without a bearer token', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/exchange/rates?date=${RATE_DATE}`)
      .expect(401);
    await request(app.getHttpServer())
      .get(
        `/api/v1/exchange/convert?amount=100&from=USD&to=COP&date=${RATE_DATE}`,
      )
      .expect(401);
  });
});
