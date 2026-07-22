import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaClient, DocType, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para el cleanup en
// beforeAll/afterAll — usa DIRECT_URL (rol owner `dentalix`, superuser)
// porque, con RLS aplicado, una conexión sin contexto de tenant (rol
// dentalix_app vía DATABASE_URL) ve 0 filas y no podría limpiar datos de
// corridas anteriores. Ver auth.e2e-spec.ts para el mismo patrón.
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

interface PatientResponseBody {
  id: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  email: string | null;
}

interface ListPatientsResponseBody {
  items: PatientResponseBody[];
  total: number;
  page: number;
  pageSize: number;
}

async function registerAndLogin(
  app: INestApplication<App>,
  opts: { clinicName: string; subdomain: string; email: string },
): Promise<{ tenantId: string; accessToken: string }> {
  const register = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({
      clinicName: opts.clinicName,
      subdomain: opts.subdomain,
      email: opts.email,
      password: 'S3cret!!',
      fullName: 'Dr. Owner',
    })
    .expect(201);
  const registerBody = register.body as RegisterResponseBody;

  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({
      subdomain: opts.subdomain,
      email: opts.email,
      password: 'S3cret!!',
    })
    .expect(201);
  const loginBody = login.body as LoginResponseBody;

  return { tenantId: registerBody.tenantId, accessToken: loginBody.accessToken };
}

describe('Patients (e2e)', () => {
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
    // FK-safe order: patients -> memberships -> users -> tenants.
    await raw.patient.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
  });

  afterAll(async () => {
    await raw.patient.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
    await app.close();
    await raw.$disconnect();
  });

  it('creates, lists and gets a patient for the authenticated tenant', async () => {
    const clinicA = await registerAndLogin(app, {
      clinicName: 'Clinica A',
      subdomain: 'clinica-a',
      email: 'owner@clinica-a.com',
    });

    const create = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        firstName: 'Ana',
        lastName: 'Gomez',
        docType: DocType.CC,
        docNumber: '1001',
        sex: Sex.F,
        // No surrounding whitespace: class-validator's IsEmail() rejects a
        // padded string as an invalid address (that's not what trim/lowercase
        // normalization is about) — mixed case alone still exercises it.
        email: 'Ana.Gomez@Example.COM',
      })
      .expect(201);
    const created = create.body as PatientResponseBody;
    expect(created.id).toBeDefined();
    expect(created.tenantId).toBe(clinicA.tenantId);
    expect(created.firstName).toBe('Ana');
    // createdById is pulled from the JWT (req.user.sub), never from the body.
    expect(created.email).toBe('ana.gomez@example.com');

    const list = await request(app.getHttpServer())
      .get('/api/v1/patients')
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const listBody = list.body as ListPatientsResponseBody;
    expect(listBody.items.some((p) => p.id === created.id)).toBe(true);
    expect(listBody.total).toBeGreaterThanOrEqual(1);

    const get = await request(app.getHttpServer())
      .get(`/api/v1/patients/${created.id}`)
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const getBody = get.body as PatientResponseBody;
    expect(getBody.id).toBe(created.id);

    const update = await request(app.getHttpServer())
      .patch(`/api/v1/patients/${created.id}`)
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ phone: '3001234567' })
      .expect(200);
    const updateBody = update.body as PatientResponseBody & {
      phone: string | null;
    };
    expect(updateBody.phone).toBe('3001234567');
  });

  it('rejects requests without a bearer token', async () => {
    await request(app.getHttpServer()).get('/api/v1/patients').expect(401);
  });

  it('isolates patients between tenants (RLS end-to-end)', async () => {
    const clinicA = await registerAndLogin(app, {
      clinicName: 'Clinica Isolation A',
      subdomain: 'clinica-iso-a',
      email: 'owner@clinica-iso-a.com',
    });
    const clinicB = await registerAndLogin(app, {
      clinicName: 'Clinica Isolation B',
      subdomain: 'clinica-iso-b',
      email: 'owner@clinica-iso-b.com',
    });

    const createA = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        firstName: 'Solo',
        lastName: 'DeA',
        docType: DocType.CC,
        docNumber: '2002',
        sex: Sex.M,
      })
      .expect(201);
    const patientA = createA.body as PatientResponseBody;

    // Clinic B's list must NOT include clinic A's patient.
    const listAsB = await request(app.getHttpServer())
      .get('/api/v1/patients')
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .expect(200);
    const listAsBBody = listAsB.body as ListPatientsResponseBody;
    expect(listAsBBody.items.some((p) => p.id === patientA.id)).toBe(false);

    // Clinic B fetching clinic A's patient by id must 404 (RLS makes the row
    // invisible; a missing row and a cross-tenant row are indistinguishable
    // by design — see GetPatientUseCase).
    await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}`)
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .expect(404);

    // Sanity: clinic A still sees its own patient.
    const listAsA = await request(app.getHttpServer())
      .get('/api/v1/patients')
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const listAsABody = listAsA.body as ListPatientsResponseBody;
    expect(listAsABody.items.some((p) => p.id === patientA.id)).toBe(true);
  });
});
