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
  registerBody,
} from './support/location-fixtures';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para el cleanup/seed en
// beforeAll — usa DIRECT_URL (rol owner `dentalix`, superuser), mismo patrón
// que auth.e2e-spec.ts / tenant-host.e2e-spec.ts.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface RegisterResponseBody {
  tenantId: string;
  userId: string;
}

interface BrandingResponseBody {
  name: string;
  primaryColor: string;
  logoUrl: string | null;
}

describe('Public tenant branding (e2e)', () => {
  let app: INestApplication<App>;
  let tenantId: string;

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
    await app.listen(0, '127.0.0.1');
    await resetDatabase(raw);

    const register = await registerVerified(
      app,
      registerBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: 'Sonrisa Branding',
        subdomain: 'sonrisa-branding',
        email: 'owner@sonrisa-branding.com',
        password: 'S3cret!!',
        fullName: 'Dr. Owner',
      }),
    );
    tenantId = (register.body as RegisterResponseBody).tenantId;

    await raw.tenant.update({
      where: { id: tenantId },
      data: {
        primaryColor: '#AA1155',
        logoUrl: 'https://cdn.example.com/logo.png',
      },
    });
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('returns the branding for the host-resolved tenant with NO Authorization header', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/public/tenant/branding')
      .set('X-Tenant-Host', hostFor('sonrisa-branding'))
      .expect(200);

    const body = res.body as BrandingResponseBody;
    expect(body).toEqual({
      name: 'Sonrisa Branding',
      primaryColor: '#AA1155',
      logoUrl: 'https://cdn.example.com/logo.png',
    });
  });

  it('returns 404 when the host resolves to no tenant', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/public/tenant/branding')
      .set('X-Tenant-Host', hostFor('ghost-branding'))
      .expect(404);
  });

  it('returns 404 when no tenant host header/context is present at all', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/public/tenant/branding')
      .expect(404);
  });
});
