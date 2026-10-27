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

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const PASSWORD = 'Sup3rSecret!';

describe('patient location (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  const sub = 'locclinic';
  let coCityId: number;

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

    await registerVerified(
      app,
      registerBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: 'Loc',
        subdomain: sub,
        email: 'o@loc.com',
        password: PASSWORD,
        fullName: 'Dr',
      }),
    );
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(sub))
      .send({ email: 'o@loc.com', password: PASSWORD })
      .expect(201);
    token = (login.body as { accessToken: string }).accessToken;

    const co = await raw.city.findFirst({
      where: { countryCode: 'CO' },
      select: { id: true },
    });
    coCityId = co!.id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('creates a patient with a valid country + city', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('X-Tenant-Host', hostFor(sub))
      .set('Authorization', `Bearer ${token}`)
      .send({
        firstName: 'Ana',
        lastName: 'G',
        docType: 'CC',
        sex: 'F',
        countryCode: 'CO',
        cityId: coCityId,
      })
      .expect(201);
    const body = res.body as { countryCode: string; cityId: number };
    expect(body.countryCode).toBe('CO');
    expect(body.cityId).toBe(coCityId);
  });

  it('rejects a city that does not belong to the country', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('X-Tenant-Host', hostFor(sub))
      .set('Authorization', `Bearer ${token}`)
      .send({
        firstName: 'B',
        lastName: 'B',
        docType: 'CC',
        sex: 'M',
        countryCode: 'US',
        cityId: coCityId,
      })
      .expect(400);
  });

  it('rejects cityId without countryCode', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('X-Tenant-Host', hostFor(sub))
      .set('Authorization', `Bearer ${token}`)
      .send({
        firstName: 'C',
        lastName: 'C',
        docType: 'CC',
        sex: 'M',
        cityId: coCityId,
      })
      .expect(400);
  });
});
