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

interface LoginResponseBody {
  accessToken: string;
  refreshToken: string;
}

async function register(app: INestApplication<App>, subdomain: string) {
  await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({
      clinicName: subdomain,
      subdomain,
      email: `owner@${subdomain}.com`,
      password: 'S3cret!!',
      fullName: 'Dr. Owner',
    })
    .expect(201);
}

async function login(app: INestApplication<App>, subdomain: string) {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(subdomain))
    .send({ email: `owner@${subdomain}.com`, password: 'S3cret!!' })
    .expect(201);
  return (res.body as LoginResponseBody).accessToken;
}

describe('Tenant host resolution (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
    await register(app, 'tenant-a');
    await register(app, 'tenant-b');
  });

  afterAll(async () => {
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
    await app.close();
    await raw.$disconnect();
  });

  it('logs in when the host resolves to a tenant', async () => {
    const token = await login(app, 'tenant-a');
    expect(token).toBeDefined();
  });

  it('rejects login when the host resolves to no tenant', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor('ghost'))
      .send({ email: 'owner@tenant-a.com', password: 'S3cret!!' })
      .expect(401);
  });

  it('accepts a protected request on the token’s own host', async () => {
    const token = await login(app, 'tenant-a');
    await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', hostFor('tenant-a'))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('rejects a token presented on another tenant’s host', async () => {
    const token = await login(app, 'tenant-a');
    await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', hostFor('tenant-b'))
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });
});
