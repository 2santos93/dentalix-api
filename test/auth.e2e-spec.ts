import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  registerBody as clinicRegisterBody,
} from './support/location-fixtures';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para el cleanup en beforeAll —
// usa DIRECT_URL (rol owner `dentalix`, superuser) porque, con RLS aplicado, una
// conexión sin contexto de tenant (rol dentalix_app vía DATABASE_URL) ve 0 filas
// en clinic_memberships y no podría limpiar datos de corridas anteriores; borrar
// solo users/tenants entonces fallaría por FK RESTRICT desde memberships huérfanas.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
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
    await resetDatabase(raw);
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('registers a clinic and logs the owner in', async () => {
    const register = await registerVerified(
      app,
      clinicRegisterBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: 'Sonrisa',
        subdomain: 'sonrisa',
        email: 'owner@sonrisa.com',
        password: 'S3cret!!',
        fullName: 'Dr. Owner',
      }),
    );
    const registerBody = register.body as RegisterResponseBody;
    expect(registerBody.tenantId).toBeDefined();

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor('sonrisa'))
      .send({
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
        email: 'owner@sonrisa.com',
        password: 'nope',
      })
      .expect(401);
  });

  it('rejects login when the host resolves to no tenant', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor('does-not-exist'))
      .send({ email: 'owner@sonrisa.com', password: 'S3cret!!' })
      .expect(401);
  });

  it('sets up a clinic and confirms refresh works before logout', async () => {
    // Nueva clínica aislada para no chocar con los otros tests.
    await registerVerified(
      app,
      clinicRegisterBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: 'Muela',
        subdomain: 'muela',
        email: 'owner@muela.com',
        password: 'S3cret!!',
        fullName: 'Dra. Muela',
      }),
    );

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor('muela'))
      .send({ email: 'owner@muela.com', password: 'S3cret!!' })
      .expect(201);
    const { refreshToken } = login.body as LoginResponseBody;

    // Antes del logout, el refresh funciona.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(201);
  });

  it('rejects refresh after logout and stays 204 on repeat logout', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor('muela'))
      .send({ email: 'owner@muela.com', password: 'S3cret!!' })
      .expect(201);
    const { refreshToken } = login.body as LoginResponseBody;

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken })
      .expect(204);

    // El refresh revocado ahora es 401.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);

    // Logout repetido con el mismo token sigue siendo 204 (idempotente).
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken })
      .expect(204);
  });
});
