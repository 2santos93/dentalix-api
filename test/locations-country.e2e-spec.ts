import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { setupSwagger } from '../src/config/swagger';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_TOKYO_FIXTURE,
  locationBody,
  registerBody,
} from './support/location-fixtures';

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const PASSWORD = 'S3cret!!';
const SUBDOMAIN = 'pais-iso';

interface LoginBody {
  accessToken: string;
}
interface LocationBody {
  id: string;
  country: string;
}

describe('País de la sede: cualquier código de la lista (DX-312, e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let tenantId: string;
  let adminUserId: string;

  const admin = () => ({
    post: (path: string) =>
      request(app.getHttpServer())
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', hostFor(SUBDOMAIN))
        .set('Authorization', `Bearer ${token}`),
    patch: (path: string) =>
      request(app.getHttpServer())
        .patch(`/api/v1${path}`)
        .set('X-Tenant-Host', hostFor(SUBDOMAIN))
        .set('Authorization', `Bearer ${token}`),
  });

  const rawCountries = async (id: string) =>
    (
      await raw.$queryRaw<{ country: string | null; countryCode: string }[]>`
        SELECT "country"::text AS "country", "countryCode"
        FROM "locations" WHERE "id" = ${id}::uuid`
    )[0];

  const create = (country: unknown, name = 'Sede país') => {
    const { country: _omit, ...rest } = locationBody(REGIONAL_TOKYO_FIXTURE);
    void _omit;
    return admin()
      .post('/locations')
      .send({ ...rest, name, ...(country === undefined ? {} : { country }) });
  };

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
      registerBody(REGIONAL_TOKYO_FIXTURE, {
        clinicName: 'Clínica País',
        subdomain: SUBDOMAIN,
        email: 'owner@pais-iso.test',
        password: PASSWORD,
        fullName: 'Dr. Owner',
      }),
    );
    tenantId = register.body.tenantId;
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(SUBDOMAIN))
      .send({ email: 'owner@pais-iso.test', password: PASSWORD })
      .expect(201);
    token = (login.body as LoginBody).accessToken;
    adminUserId = (
      await raw.clinicMembership.findFirstOrThrow({ where: { tenantId } })
    ).userId;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('POST /locations without country is 400 with field country', async () => {
    const res = await create(undefined).expect(400);
    expect(res.body).toMatchObject({
      message: 'Elige el país de la sede.',
      field: 'country',
    });
    await create(null).expect(400);
    await create('').expect(400);
  });

  it('POST /locations with a code that is not in countries is 400', async () => {
    const unknown = await create('XX').expect(400);
    expect(unknown.body).toMatchObject({
      message: 'El país «XX» no está en la lista de países.',
      field: 'country',
    });
    const long = await create('x'.repeat(500)).expect(400);
    expect(long.body).toMatchObject({
      message: 'El país indicado no está en la lista de países.',
      field: 'country',
    });
    await create(5).expect(400);
  });

  it('POST /locations with any listed code is 201 and returns it uppercase', async () => {
    for (const [sent, stored] of [
      ['VE', 'VE'],
      ['jp', 'JP'],
      ['KE', 'KE'],
    ]) {
      const res = await create(sent, `Sede ${stored}`).expect(201);
      expect((res.body as LocationBody).country).toBe(stored);
    }
  });

  it('a location outside the legacy pair stores no legacy country', async () => {
    const res = await create('VE', 'Sede Caracas').expect(201);
    expect(await rawCountries((res.body as LocationBody).id)).toEqual({
      country: null,
      countryCode: 'VE',
    });
  });

  it('legacy: a location in ES still stores the legacy ES', async () => {
    const res = await create('ES', 'Sede Madrid').expect(201);
    expect(await rawCountries((res.body as LocationBody).id)).toEqual({
      country: 'ES',
      countryCode: 'ES',
    });
  });

  it('PATCH /locations/:id with country null is 400; with a listed code is 200; with an unknown code is 400', async () => {
    const { id } = (await create('CO', 'Sede editable').expect(201))
      .body as LocationBody;
    const nulled = await admin()
      .patch(`/locations/${id}`)
      .send({ country: null })
      .expect(400);
    expect(nulled.body).toMatchObject({
      message: 'Elige el país de la sede.',
      field: 'country',
    });
    await admin().patch(`/locations/${id}`).send({ country: '' }).expect(400);
    const unknown = await admin()
      .patch(`/locations/${id}`)
      .send({ country: 'XX' })
      .expect(400);
    expect(unknown.body).toMatchObject({ field: 'country' });
    // Ausente: no cambia.
    await admin()
      .patch(`/locations/${id}`)
      .send({ name: 'Renombrada' })
      .expect(200);
    expect((await rawCountries(id)).countryCode).toBe('CO');
    const ok = await admin()
      .patch(`/locations/${id}`)
      .send({ country: 've' })
      .expect(200);
    expect((ok.body as LocationBody).country).toBe('VE');
    expect(await rawCountries(id)).toEqual({
      country: null,
      countryCode: 'VE',
    });
  });

  it('changing the country is audited as a changed field without values', async () => {
    const { id } = (await create('CO', 'Sede auditada').expect(201))
      .body as LocationBody;
    await admin().patch(`/locations/${id}`).send({ country: 'JP' }).expect(200);
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId,
        action: 'UPDATE',
        resourceType: 'LOCATION',
        resourceId: id,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(adminUserId);
    expect(events[0].metadata).toEqual({
      changedFields: ['country'],
      params: { id },
    });
  });

  it('the OpenAPI document has no ClinicCountry schema, no country example and no phone promise in the country description', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const docsApp = moduleRef.createNestApplication<INestApplication<App>>();
    docsApp.setGlobalPrefix('api/v1');
    setupSwagger(docsApp);
    await docsApp.init();
    try {
      const doc = (
        await request(docsApp.getHttpServer()).get('/docs-json').expect(200)
      ).body as {
        components: {
          schemas: Record<
            string,
            { properties?: Record<string, Record<string, unknown>> }
          >;
        };
      };
      expect(Object.keys(doc.components.schemas)).not.toContain(
        'ClinicCountry',
      );
      for (const [dto, field] of [
        ['LocationDto', 'country'],
        ['CreateLocationDto', 'country'],
        ['UpdateLocationDto', 'country'],
        ['RegisterDto', 'locationCountry'],
      ]) {
        const property = doc.components.schemas[dto].properties![field];
        expect(property.type).toBe('string');
        expect(property.enum).toBeUndefined();
        expect(property.example).toBeUndefined();
        expect(String(property.description)).not.toMatch(
          /tel[eé]fono|indicativo|\+\d|whatsapp/i,
        );
      }
    } finally {
      await docsApp.close();
    }
  });
});
