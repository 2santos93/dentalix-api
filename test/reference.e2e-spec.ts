import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const PASSWORD = 'Sup3rSecret!';

async function registerAndLogin(app: INestApplication<App>) {
  const sub = 'refclinic';
  await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({
      clinicName: 'Ref Clinic',
      subdomain: sub,
      email: 'owner@ref.com',
      password: PASSWORD,
      fullName: 'Dr. Ref',
    })
    .expect(201);
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(sub))
    .send({ email: 'owner@ref.com', password: PASSWORD })
    .expect(201);
  return { token: (login.body as { accessToken: string }).accessToken, sub };
}

describe('reference endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let sub: string;

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

    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenantDomain.deleteMany();
    await raw.tenant.deleteMany();

    ({ token, sub } = await registerAndLogin(app));
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('401 without a token', async () => {
    await request(app.getHttpServer()).get('/api/v1/currencies').expect(401);
  });

  it('GET /currencies returns the seeded list incl. USD', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/currencies')
      .set('X-Tenant-Host', hostFor(sub))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = res.body as { code: string; symbol: string }[];
    expect(body.some((c) => c.code === 'USD' && c.symbol === '$')).toBe(true);
  });
});
