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
}
interface RegisterDomainBody {
  domain: { id: string; host: string; status: string; verifyToken: string };
  dns: { name: string; type: string; value: string };
}

const SUB = 'clinica-domains';
const CUSTOM = 'citas.clinica-domains-white.com';

describe('Domains (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;

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
    await raw.tenantDomain.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        clinicName: 'Clinica Domains',
        subdomain: SUB,
        email: `owner@${SUB}.com`,
        password: 'S3cret!!',
        fullName: 'Dr. Owner',
      })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(SUB))
      .send({ email: `owner@${SUB}.com`, password: 'S3cret!!' })
      .expect(201);
    token = (login.body as LoginResponseBody).accessToken;
  });

  afterAll(async () => {
    await raw.tenantDomain.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
    await app.close();
    await raw.$disconnect();
  });

  it('registers a custom domain as PENDING with DNS instructions', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/domains')
      .set('X-Tenant-Host', hostFor(SUB))
      .set('Authorization', `Bearer ${token}`)
      .send({ host: CUSTOM })
      .expect(201);
    const body = res.body as RegisterDomainBody;
    expect(body.domain.status).toBe('PENDING');
    expect(body.dns).toEqual({
      name: `_dentalix-verify.${CUSTOM}`,
      type: 'TXT',
      value: body.domain.verifyToken,
    });
  });

  it('does NOT resolve a pending custom domain', async () => {
    // Token is valid, but the pending host resolves to no tenant -> 401.
    await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', CUSTOM)
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('resolves a verified custom domain', async () => {
    await raw.tenantDomain.updateMany({
      where: { host: CUSTOM },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    });
    await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', CUSTOM)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('lists the tenant’s domains', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/domains')
      .set('X-Tenant-Host', hostFor(SUB))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as Array<{ host: string }>)[0].host).toBe(CUSTOM);
  });
});
