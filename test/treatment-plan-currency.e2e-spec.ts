import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DocType, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para cleanup -- usa
// DIRECT_URL (rol owner `dentalix`, superuser) porque, con RLS aplicado, una
// conexión sin contexto de tenant (rol dentalix_app vía DATABASE_URL) ve 0
// filas y no podría limpiar datos ajenos al tenant. Mismo patrón que
// payments.e2e-spec.ts / patients-location.e2e-spec.ts.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const PASSWORD = 'Sup3rSecret!';

interface LoginResponseBody {
  accessToken: string;
}

interface PatientResponseBody {
  id: string;
}

async function cleanup(): Promise<void> {
  // FK-safe order: Payment -> TreatmentPlanItem -> TreatmentPlan -> Patient
  // -> ClinicMembership -> User -> TenantDomain -> Tenant (same convention
  // as payments.e2e-spec.ts / patients-location.e2e-spec.ts). This suite
  // never creates a payment or a plan item, but the deletes are harmless
  // no-ops when there are no rows, so the full order is kept for safety.
  await raw.payment.deleteMany();
  await raw.treatmentPlanItem.deleteMany();
  await raw.treatmentPlan.deleteMany();
  await raw.patient.deleteMany();
  await raw.clinicMembership.deleteMany();
  await raw.user.deleteMany();
  await raw.tenantDomain.deleteMany();
  await raw.tenant.deleteMany();
}

describe('treatment plan currency whitelist (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let patientId: string;
  const sub = 'currencyclinic';

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

    await cleanup();

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        clinicName: 'Currency Clinic',
        subdomain: sub,
        email: 'owner@currency-clinic.com',
        password: PASSWORD,
        fullName: 'Dr. Owner',
      })
      .expect(201);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(sub))
      .send({ email: 'owner@currency-clinic.com', password: PASSWORD })
      .expect(201);
    token = (login.body as LoginResponseBody).accessToken;

    const createPatient = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('X-Tenant-Host', hostFor(sub))
      .set('Authorization', `Bearer ${token}`)
      .send({
        firstName: 'Moneda',
        lastName: 'Test',
        docType: DocType.CC,
        docNumber: 'CUR-001',
        sex: Sex.F,
      })
      .expect(201);
    patientId = (createPatient.body as PatientResponseBody).id;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it('creates a plan with an allowed currency and rejects an unknown one', async () => {
    const ok = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/treatment-plans`)
      .set('X-Tenant-Host', hostFor(sub))
      .set('Authorization', `Bearer ${token}`)
      .send({ currency: 'COP' })
      .expect(201);
    expect((ok.body as { currency: string }).currency).toBe('COP');

    await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/treatment-plans`)
      .set('X-Tenant-Host', hostFor(sub))
      .set('Authorization', `Bearer ${token}`)
      .send({ currency: 'XXX' })
      .expect(400);
  });

  it('defaults to USD when currency is omitted', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/treatment-plans`)
      .set('X-Tenant-Host', hostFor(sub))
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);
    expect((res.body as { currency: string }).currency).toBe('USD');
  });

  it('accepts a lowercase currency (normalized to uppercase)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/treatment-plans`)
      .set('X-Tenant-Host', hostFor(sub))
      .set('Authorization', `Bearer ${token}`)
      .send({ currency: 'eur' })
      .expect(201);
    expect((res.body as { currency: string }).currency).toBe('EUR');
  });

  it('validates currency on PATCH only when provided, and rejects an unknown one', async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientId}/treatment-plans`)
      .set('X-Tenant-Host', hostFor(sub))
      .set('Authorization', `Bearer ${token}`)
      .send({ currency: 'USD' })
      .expect(201);
    const planId = (created.body as { id: string }).id;

    const patched = await request(app.getHttpServer())
      .patch(`/api/v1/treatment-plans/${planId}`)
      .set('X-Tenant-Host', hostFor(sub))
      .set('Authorization', `Bearer ${token}`)
      .send({ currency: 'mxn' })
      .expect(200);
    expect((patched.body as { currency: string }).currency).toBe('MXN');

    await request(app.getHttpServer())
      .patch(`/api/v1/treatment-plans/${planId}`)
      .set('X-Tenant-Host', hostFor(sub))
      .set('Authorization', `Bearer ${token}`)
      .send({ currency: 'ZZZ' })
      .expect(400);

    // Currency untouched by a patch that omits it entirely.
    const notesOnly = await request(app.getHttpServer())
      .patch(`/api/v1/treatment-plans/${planId}`)
      .set('X-Tenant-Host', hostFor(sub))
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'sin cambio de moneda' })
      .expect(200);
    expect((notesOnly.body as { currency: string }).currency).toBe('MXN');
  });
});
