import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  registerBody,
} from './support/location-fixtures';

// SEC-004: los endpoints que reciben `:patientId` en la ruta tienen que
// resolver el paciente en la clínica en contexto ANTES de insertar. Antes
// insertaban el id tal cual: la FK simple `patientId -> patients(id)` se
// chequea saltando la RLS, así que la clínica A creaba filas que apuntaban a
// un paciente de la clínica B (y un UUID inexistente devolvía 500, un oráculo
// de existencia entre tenants).
//
// `raw` (DIRECT_URL, rol owner) solo se usa para limpiar y para contar filas
// sin RLS: es la única forma de comprobar que NO se insertó nada en ningún
// tenant. Mismo patrón que appointments.e2e-spec.ts.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const PASSWORD = 'S3cret!!';
const SUBDOMAINS = ['clinica-fk-a', 'clinica-fk-b'];

interface Clinic {
  accessToken: string;
  subdomain: string;
}

async function registerAndLogin(
  app: INestApplication<App>,
  subdomain: string,
): Promise<Clinic> {
  const email = `owner@${subdomain}.com`;
  await registerVerified(
    app,
    registerBody(REGIONAL_BOGOTA_FIXTURE, {
      clinicName: subdomain,
      subdomain,
      email,
      password: PASSWORD,
      fullName: 'Dr. Owner',
    }),
  );
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(subdomain))
    .send({ email, password: PASSWORD })
    .expect(201);
  return {
    accessToken: (login.body as { accessToken: string }).accessToken,
    subdomain,
  };
}

async function createPatient(
  app: INestApplication<App>,
  clinic: Clinic,
  docNumber: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/patients')
    .set('X-Tenant-Host', hostFor(clinic.subdomain))
    .set('Authorization', `Bearer ${clinic.accessToken}`)
    .send({
      firstName: 'Paciente',
      lastName: 'Ajeno',
      docType: 'NATIONAL_ID',
      docNumber,
      sex: Sex.F,
    })
    .expect(201);
  return (res.body as { id: string }).id;
}

async function cleanup(): Promise<void> {
  await resetDatabase(raw);
  // El registro crea la sede por defecto y su horario: se borran los de las
  // clínicas de ESTE spec (no las de otros) antes de borrar los tenants.
  const ours = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ourTenants = { tenantId: { in: ours.map((t) => t.id) } };
  await raw.locationScheduleRange.deleteMany({ where: ourTenants });
  await raw.locationSchedule.deleteMany({ where: ourTenants });
  await raw.location.deleteMany({ where: ourTenants });
  await resetDatabase(raw);
}

interface Endpoint {
  name: string;
  method: 'post' | 'put';
  path: (patientId: string) => string;
  body: object;
  okStatus: number;
  count: (patientId: string) => Promise<number>;
}

const ENDPOINTS: Endpoint[] = [
  {
    name: 'POST /patients/:patientId/treatment-plans',
    method: 'post',
    path: (id) => `/api/v1/patients/${id}/treatment-plans`,
    body: { notes: 'Plan' },
    okStatus: 201,
    count: (patientId) => raw.treatmentPlan.count({ where: { patientId } }),
  },
  {
    name: 'PUT /patients/:patientId/medical-history',
    method: 'put',
    path: (id) => `/api/v1/patients/${id}/medical-history`,
    body: { notes: 'Anamnesis' },
    okStatus: 200,
    count: (patientId) =>
      raw.medicalHistoryVersion.count({ where: { patientId } }),
  },
  {
    name: 'POST /patients/:patientId/clinical-entries',
    method: 'post',
    path: (id) => `/api/v1/patients/${id}/clinical-entries`,
    body: { notes: 'Evolución' },
    okStatus: 201,
    count: (patientId) => raw.clinicalEntry.count({ where: { patientId } }),
  },
  {
    name: 'POST /patients/:patientId/tooth-records',
    method: 'post',
    path: (id) => `/api/v1/patients/${id}/tooth-records`,
    body: { toothNumber: '11', kind: 'DIAGNOSIS' },
    okStatus: 201,
    count: (patientId) => raw.toothRecord.count({ where: { patientId } }),
  },
];

describe('Pertenencia del paciente al tenant en endpoints clínicos (SEC-004, e2e)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let patientA: string;
  let patientB: string;

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
    await cleanup();

    clinicA = await registerAndLogin(app, SUBDOMAINS[0]);
    const clinicB = await registerAndLogin(app, SUBDOMAINS[1]);
    patientA = await createPatient(app, clinicA, '9101');
    patientB = await createPatient(app, clinicB, '9102');
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  function send(endpoint: Endpoint, patientId: string): request.Test {
    return request(app.getHttpServer())
      [endpoint.method](endpoint.path(patientId))
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send(endpoint.body);
  }

  // `:patientId` pasa por ParseUUIDPipe: un id que no es UUID es un 400 de
  // validación, no un 500 de Postgres (columna uuid) ni un 404.
  describe.each([
    ['post', '/api/v1/patients/no-es-uuid/treatment-plans'],
    ['get', '/api/v1/patients/no-es-uuid/treatment-plans'],
    ['put', '/api/v1/patients/no-es-uuid/medical-history'],
    ['get', '/api/v1/patients/no-es-uuid/medical-history'],
    ['post', '/api/v1/patients/no-es-uuid/clinical-entries'],
    ['get', '/api/v1/patients/no-es-uuid/clinical-entries'],
    ['post', '/api/v1/patients/no-es-uuid/tooth-records'],
    ['get', '/api/v1/patients/no-es-uuid/odontogram'],
    ['get', '/api/v1/patients/no-es-uuid/teeth/11/history'],
  ] as const)('%s %s con :patientId que no es UUID', (method, path) => {
    it('responde 400', async () => {
      await request(app.getHttpServer())
        [method](path)
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ notes: 'x', toothNumber: '11', kind: 'DIAGNOSIS' })
        .expect(400);
    });
  });

  describe.each(ENDPOINTS)('$name', (endpoint) => {
    it('con token de la clínica A y paciente de la clínica B: 404 y nada insertado', async () => {
      const res = await send(endpoint, patientB).expect(404);
      expect((res.body as { message: string }).message).toBe(
        'Paciente no encontrado',
      );
      expect(await endpoint.count(patientB)).toBe(0);
    });

    it('con un UUID inexistente: 404 (no 500), así no sirve de oráculo de existencia', async () => {
      const ghost = randomUUID();
      const res = await send(endpoint, ghost).expect(404);
      expect((res.body as { message: string }).message).toBe(
        'Paciente no encontrado',
      );
      expect(await endpoint.count(ghost)).toBe(0);
    });

    it('con un paciente de la propia clínica sigue funcionando', async () => {
      await send(endpoint, patientA).expect(endpoint.okStatus);
      expect(await endpoint.count(patientA)).toBeGreaterThan(0);
    });
  });
});
