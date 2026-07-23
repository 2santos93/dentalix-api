import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para el cleanup en beforeAll —
// usa DIRECT_URL (rol owner `dentalix`, superuser) porque, con RLS aplicado, una
// conexión sin contexto de tenant (rol dentalix_app vía DATABASE_URL) ve 0 filas
// en clinic_memberships y no podría limpiar datos de corridas anteriores; borrar
// solo users/tenants entonces fallaría por FK RESTRICT desde memberships huérfanas.
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

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;

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
    // FK-safe order: memberships -> users -> tenants.
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('registers a clinic and logs the owner in', async () => {
    const register = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        clinicName: 'Sonrisa',
        subdomain: 'sonrisa',
        email: 'owner@sonrisa.com',
        password: 'S3cret!!',
        fullName: 'Dr. Owner',
      })
      .expect(201);
    const registerBody = register.body as RegisterResponseBody;
    expect(registerBody.tenantId).toBeDefined();

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor('sonrisa'))
      .send({
        subdomain: 'sonrisa',
        email: 'owner@sonrisa.com',
        password: 'S3cret!!',
      })
      .expect(201);
    const loginBody = login.body as LoginResponseBody;
    expect(loginBody.accessToken).toBeDefined();
    expect(loginBody.refreshToken).toBeDefined();
  });

  it('rejects login with a wrong password', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor('sonrisa'))
      .send({
        subdomain: 'sonrisa',
        email: 'owner@sonrisa.com',
        password: 'nope',
      })
      .expect(401);
  });
});
