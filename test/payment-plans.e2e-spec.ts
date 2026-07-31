import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { CatalogKind, ClinicRole, DocType, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';

// Same admin/superuser connection convention as payments.e2e-spec.ts /
// dashboard.e2e-spec.ts / treatment-plans.e2e-spec.ts: DIRECT_URL bypasses RLS
// so seed/cleanup can touch rows across tenants.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const SEEDED_PASSWORD = 'S3cret!!';

// Far-future start date so every installment is deterministically PENDING
// (never OVERDUE) regardless of when this suite runs.
const START_DATE = '2099-01-01T00:00:00.000Z';
const PAID_AT = '2026-07-01T09:00:00.000Z';

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
}

interface CatalogItemResponseBody {
  id: string;
  defaultPrice: number | null;
}

interface TreatmentPlanResponseBody {
  id: string;
  currency: string;
}

interface TreatmentPlanItemResponseBody {
  id: string;
  status: string;
}

interface InstallmentViewBody {
  sequence: number;
  dueDate: string;
  amount: number;
  covered: number;
  status: string;
}

interface PaymentPlanResponseBody {
  id: string;
  treatmentPlanId: string;
  currency: string;
  status: string;
  totalToFinance: number;
  downPayment: number;
  financedAmount: number;
  installmentsCount: number;
  periodicity: string;
  startDate: string;
  paidTotal: number;
  remaining: number;
  installments: InstallmentViewBody[];
  isFullyPaid: boolean;
}

interface PaymentResponseBody {
  id: string;
  amount: number;
  currency: string;
}

async function registerAndLogin(
  app: INestApplication<App>,
  opts: { clinicName: string; subdomain: string; email: string },
): Promise<{
  tenantId: string;
  userId: string;
  accessToken: string;
  subdomain: string;
}> {
  const register = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({
      clinicName: opts.clinicName,
      subdomain: opts.subdomain,
      email: opts.email,
      password: SEEDED_PASSWORD,
      fullName: 'Dr. Owner',
    })
    .expect(201);
  const registerBody = register.body as RegisterResponseBody;

  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(opts.subdomain))
    .send({
      email: opts.email,
      password: SEEDED_PASSWORD,
    })
    .expect(201);
  const loginBody = login.body as LoginResponseBody;

  return {
    tenantId: registerBody.tenantId,
    userId: registerBody.userId,
    accessToken: loginBody.accessToken,
    subdomain: opts.subdomain,
  };
}

async function createPatient(
  app: INestApplication<App>,
  accessToken: string,
  subdomain: string,
  docNumber: string,
): Promise<PatientResponseBody> {
  const create = await request(app.getHttpServer())
    .post('/api/v1/patients')
    .set('X-Tenant-Host', hostFor(subdomain))
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      firstName: 'Cuotas',
      lastName: 'Test',
      docType: DocType.CC,
      docNumber,
      sex: Sex.F,
    })
    .expect(201);
  return create.body as PatientResponseBody;
}

// Seeds a user with a hashed password + clinic membership at the given role,
// bypassing RLS (no staff-invite endpoint yet) -- same pattern as
// payments.e2e-spec.ts / sales.e2e-spec.ts / treatment-plans.e2e-spec.ts.
async function seedRoledMember(
  tenantId: string,
  email: string,
  role: ClinicRole,
  fullName: string,
): Promise<{ userId: string }> {
  const passwordHash = await passwordService.hash(SEEDED_PASSWORD);
  const user = await raw.user.create({
    data: {
      email,
      passwordHash,
      fullName,
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });
  await raw.clinicMembership.create({
    data: { tenantId, userId: user.id, role },
  });
  return { userId: user.id };
}

async function loginAs(
  app: INestApplication<App>,
  opts: { subdomain: string; email: string },
): Promise<string> {
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(opts.subdomain))
    .send({
      email: opts.email,
      password: SEEDED_PASSWORD,
    })
    .expect(201);
  return (login.body as LoginResponseBody).accessToken;
}

async function cleanup(): Promise<void> {
  // FK-safe order: Payment -> Installment -> PaymentPlan (onDelete: Restrict
  // on TreatmentPlan) -> TreatmentPlanItem -> DentalCatalogItem -> Patient ->
  // ClinicMembership -> User -> Tenant. Same convention as
  // payments.e2e-spec.ts / dashboard.e2e-spec.ts / treatment-plans.e2e-spec.ts.
  await raw.payment.deleteMany();
  await raw.installment.deleteMany();
  await raw.paymentPlan.deleteMany();
  await raw.treatmentPlanItem.deleteMany();
  await raw.treatmentPlan.deleteMany();
  await raw.dentalCatalogItem.deleteMany();
  await raw.patient.deleteMany();
  await raw.clinicMembership.deleteMany();
  await raw.user.deleteMany();
  await raw.tenant.deleteMany();
}

describe('Payment plans / cuotas (e2e)', () => {
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

    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it(
    'enforces PAYMENT_ROLES, creates/reads/cancels a payment plan and ' +
      'tracks abonos against it',
    async () => {
      const subdomain = 'clinica-cuotas-a';
      const clinic = await registerAndLogin(app, {
        clinicName: 'Clinica Cuotas A',
        subdomain,
        email: 'owner@clinica-cuotas-a.com',
      });
      const patient = await createPatient(
        app,
        clinic.accessToken,
        clinic.subdomain,
        'CUOTAS-A-001',
      );

      // --- 0. Seed a PROCEDURE catalog item priced so a single ACCEPTED item
      // makes the plan's balance exactly 1200.
      const createCatalogItem = await request(app.getHttpServer())
        .post('/api/v1/catalog/items')
        .set('X-Tenant-Host', hostFor(clinic.subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .send({
          code: 'RESINA-CUOTAS-001',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Resina',
          color: '#2A2B3C',
          defaultPrice: 1200,
        })
        .expect(201);
      const catalogItem = createCatalogItem.body as CatalogItemResponseBody;

      // --- 1. Create a treatment plan (currency defaults to USD).
      const createPlan = await request(app.getHttpServer())
        .post(`/api/v1/patients/${patient.id}/treatment-plans`)
        .set('X-Tenant-Host', hostFor(clinic.subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .send({ notes: 'Plan de cuotas' })
        .expect(201);
      const plan = createPlan.body as TreatmentPlanResponseBody;
      expect(plan.currency).toBe('USD');

      // --- 2. Add one item and accept it -> billable = 1200 (balance = 1200).
      const addItem = await request(app.getHttpServer())
        .post(`/api/v1/treatment-plans/${plan.id}/items`)
        .set('X-Tenant-Host', hostFor(clinic.subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .send({ toothNumber: '11', catalogItemId: catalogItem.id })
        .expect(201);
      const item = addItem.body as TreatmentPlanItemResponseBody;

      await request(app.getHttpServer())
        .patch(`/api/v1/treatment-plans/${plan.id}/items/${item.id}`)
        .set('X-Tenant-Host', hostFor(clinic.subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .send({ status: 'ACCEPTED' })
        .expect(200);

      // --- 3. Roles: DENTIST is not in PAYMENT_ROLES -> 403 on create.
      await seedRoledMember(
        clinic.tenantId,
        'dentist@clinica-cuotas-a.com',
        ClinicRole.DENTIST,
        'Seeded DENTIST',
      );
      const dentistToken = await loginAs(app, {
        subdomain,
        email: 'dentist@clinica-cuotas-a.com',
      });

      await request(app.getHttpServer())
        .post(`/api/v1/treatment-plans/${plan.id}/payment-plan`)
        .set('X-Tenant-Host', hostFor(subdomain))
        .set('Authorization', `Bearer ${dentistToken}`)
        .send({
          installmentsCount: 12,
          periodicity: 'MONTHLY',
          startDate: START_DATE,
        })
        .expect(403);

      // --- 4. ADMIN creates the payment plan -> 201, 12 installments,
      // totalToFinance defaults to the plan balance (1200).
      const createPaymentPlan = await request(app.getHttpServer())
        .post(`/api/v1/treatment-plans/${plan.id}/payment-plan`)
        .set('X-Tenant-Host', hostFor(subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .send({
          installmentsCount: 12,
          periodicity: 'MONTHLY',
          startDate: START_DATE,
        })
        .expect(201);
      const paymentPlan = createPaymentPlan.body as PaymentPlanResponseBody;
      expect(paymentPlan.installments.length).toBe(12);
      expect(paymentPlan.totalToFinance).toBe(1200);
      expect(paymentPlan.currency).toBe('USD');

      // --- 5. Conflict: a second identical POST -> 409 (only one active
      // payment plan per treatment plan).
      await request(app.getHttpServer())
        .post(`/api/v1/treatment-plans/${plan.id}/payment-plan`)
        .set('X-Tenant-Host', hostFor(subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .send({
          installmentsCount: 12,
          periodicity: 'MONTHLY',
          startDate: START_DATE,
        })
        .expect(409);

      // --- 6. GET -> 200, remaining = 1200 (no abonos yet), installments
      // carry a status (PENDING, since startDate is far in the future).
      const getPlan1 = await request(app.getHttpServer())
        .get(`/api/v1/treatment-plans/${plan.id}/payment-plan`)
        .set('X-Tenant-Host', hostFor(subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .expect(200);
      const getPlanBody1 = getPlan1.body as PaymentPlanResponseBody;
      expect(getPlanBody1.remaining).toBe(1200);
      expect(getPlanBody1.installments.length).toBe(12);
      expect(getPlanBody1.installments[0].status).toBe('PENDING');

      // --- 7. Abono: POST an abono in the plan's own currency (USD) so the
      // exchange-rate snapshot is never consulted (passthrough conversion) ->
      // then GET again: paidTotal reflects it.
      const abono = await request(app.getHttpServer())
        .post(`/api/v1/treatment-plans/${plan.id}/payments`)
        .set('X-Tenant-Host', hostFor(subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .send({
          amount: 100,
          currency: paymentPlan.currency,
          paidAt: PAID_AT,
          method: 'CASH',
        })
        .expect(201);
      const abonoBody = abono.body as PaymentResponseBody;
      expect(abonoBody.amount).toBe(100);
      expect(abonoBody.currency).toBe('USD');

      const getPlan2 = await request(app.getHttpServer())
        .get(`/api/v1/treatment-plans/${plan.id}/payment-plan`)
        .set('X-Tenant-Host', hostFor(subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .expect(200);
      const getPlanBody2 = getPlan2.body as PaymentPlanResponseBody;
      expect(getPlanBody2.paidTotal).toBe(100);
      expect(getPlanBody2.remaining).toBe(1100);
      // Per-installment allocation: the 100 abono exactly covers the first
      // installment (1200 / 12 = 100 each) -> covered=100 -> status PAID.
      expect(getPlanBody2.installments[0].covered).toBe(100);
      expect(getPlanBody2.installments[0].status).toBe('PAID');

      // --- 8. Cancel: DELETE -> 204; GET -> 404; a fresh POST is allowed
      // again -> 201 (cancel + re-create, no reconciliation needed).
      await request(app.getHttpServer())
        .delete(`/api/v1/treatment-plans/${plan.id}/payment-plan`)
        .set('X-Tenant-Host', hostFor(subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/api/v1/treatment-plans/${plan.id}/payment-plan`)
        .set('X-Tenant-Host', hostFor(subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .expect(404);

      const recreate = await request(app.getHttpServer())
        .post(`/api/v1/treatment-plans/${plan.id}/payment-plan`)
        .set('X-Tenant-Host', hostFor(subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .send({
          installmentsCount: 12,
          periodicity: 'MONTHLY',
          startDate: START_DATE,
        })
        .expect(201);
      const recreatedPlan = recreate.body as PaymentPlanResponseBody;
      expect(recreatedPlan.installments.length).toBe(12);
      // totalToFinance defaults to the plan's full billable (gross, 1200),
      // not the net balance after the 100 abono recorded above: prior abonos
      // count as paid against the full financed amount, since paidTotal
      // (read-time, all-time paid) would otherwise be double-counted against
      // a net default.
      expect(recreatedPlan.totalToFinance).toBe(1200);
    },
  );
});
