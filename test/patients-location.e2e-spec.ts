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

    // tooth_records referencia patients (y plan items): marcar un ítem de plan
    // como DONE crea un ToothRecord, así que se borran ANTES o el delete de
    // patients falla por FK y hace reventar el afterAll (contaminando las
    // suites siguientes).
    await raw.toothRecord.deleteMany();
    await raw.patient.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenantDomain.deleteMany();
    await raw.tenant.deleteMany();

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        clinicName: 'Loc',
        subdomain: sub,
        email: 'o@loc.com',
        password: PASSWORD,
        fullName: 'Dr',
      })
      .expect(201);
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
    // tooth_records referencia patients (y plan items): marcar un ítem de plan
    // como DONE crea un ToothRecord, así que se borran ANTES o el delete de
    // patients falla por FK y hace reventar el afterAll (contaminando las
    // suites siguientes).
    await raw.toothRecord.deleteMany();
    await raw.patient.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenantDomain.deleteMany();
    await raw.tenant.deleteMany();
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
