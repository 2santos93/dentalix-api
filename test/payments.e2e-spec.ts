import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  CatalogKind,
  ClinicRole,
  DocType,
  PrismaClient,
  Sex,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para seed/cleanup -- usa
// DIRECT_URL (rol owner `dentalix`, superuser) porque, con RLS aplicado, una
// conexión sin contexto de tenant (rol dentalix_app vía DATABASE_URL) ve 0
// filas y no podría sembrar/limpiar datos ajenos al tenant. Mismo patrón que
// dashboard.e2e-spec.ts / treatment-plans.e2e-spec.ts / role-matrix.e2e-spec.ts.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const SEEDED_PASSWORD = 'S3cret!!';

// The date this suite seeds an exchange snapshot for. EXCHANGE_APP_ID is
// blank in .env.test (see .env.test / dashboard.e2e-spec.ts), so if
// GetPlanBalanceUseCase's ConvertAmountUseCase ever fell through to the live
// provider it would throw instead of silently hitting the network -- the
// COP abono below must hit the seeded snapshot for RATE_DATE, never
// OpenExchangeRatesProvider. The USD abono never needs it at all: `from ===
// to` is a passthrough in ConvertAmountUseCase (see
// convert-amount.use-case.ts / sales.e2e-spec.ts convention).
const RATE_DATE = '2026-07-01';
const RATE_COP = 4000;

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

interface PaymentResponseBody {
  id: string;
  treatmentPlanId: string;
  patientId: string;
  amount: number;
  currency: string;
}

interface PlanBalanceResponseBody {
  planCurrency: string;
  billable: number;
  paid: number;
  balance: number;
  paymentsCount: number;
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
      firstName: 'Pago',
      lastName: 'Test',
      docType: DocType.CC,
      docNumber,
      sex: Sex.F,
    })
    .expect(201);
  return create.body as PatientResponseBody;
}

// Siembra un usuario con contraseña hasheada igual que el registro, más su
// membresía en la clínica (tenant) dada, con el rol pedido. Usa el cliente
// `raw` (DIRECT_URL, superuser) porque bypassa RLS -- no hay endpoint de
// invitación de staff todavía (mismo patrón que sales.e2e-spec.ts /
// treatment-plans.e2e-spec.ts).
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
  // FK-safe order: Payment -> TreatmentPlan (onDelete: Restrict) ->
  // TreatmentPlanItem -> DentalCatalogItem -> Patient -> ClinicMembership ->
  // User -> Tenant, plus the exchange snapshot this suite seeds directly
  // (same convention as dashboard.e2e-spec.ts / treatment-plans.e2e-spec.ts).
  // tooth_records referencia patients (y plan items): marcar un ítem de plan
  // como DONE crea un ToothRecord, así que se borran ANTES o el delete de
  // patients falla por FK y hace reventar el afterAll (contaminando las
  // suites siguientes).
  await raw.toothRecord.deleteMany();
  await raw.payment.deleteMany();
  await raw.treatmentPlanItem.deleteMany();
  await raw.treatmentPlan.deleteMany();
  await raw.dentalCatalogItem.deleteMany();
  await raw.patient.deleteMany();
  await raw.clinicMembership.deleteMany();
  await raw.user.deleteMany();
  await raw.tenant.deleteMany();
  await raw.exchangeRateSnapshot.deleteMany({ where: { date: RATE_DATE } });
}

describe('Payments (e2e)', () => {
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

    // Seed the COP snapshot directly via DIRECT_URL so GetPlanBalanceUseCase
    // -> ConvertAmountUseCase -> GetRatesForDateUseCase's cache-then-fetch
    // finds a row for RATE_DATE and returns immediately (cache hit) -- it
    // never calls OpenExchangeRatesProvider.fetchRates, so this suite needs
    // no network access and no real EXCHANGE_APP_ID.
    await raw.exchangeRateSnapshot.create({
      data: { date: RATE_DATE, currency: 'COP', rate: RATE_COP },
    });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it(
    'records/lists abonos, computes + updates the plan balance across ' +
      'currencies, voids an abono, isolates tenants and enforces PAYMENT_ROLES',
    async () => {
      const subdomainA = 'clinica-pay-a';
      const clinicA = await registerAndLogin(app, {
        clinicName: 'Clinica Pagos A',
        subdomain: subdomainA,
        email: 'owner@clinica-pay-a.com',
      });
      const patientA = await createPatient(
        app,
        clinicA.accessToken,
        clinicA.subdomain,
        'PAY-A-001',
      );

      // --- 0. Seed a PROCEDURE catalog item with a known defaultPrice.
      const createCatalogItem = await request(app.getHttpServer())
        .post('/api/v1/catalog/items')
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({
          code: 'RESINA-PAY-001',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Resina',
          color: '#2A2B3C',
          defaultPrice: 100,
        })
        .expect(201);
      const catalogItem = createCatalogItem.body as CatalogItemResponseBody;

      // --- 1. Create a treatment plan (currency defaults to USD).
      const createPlan = await request(app.getHttpServer())
        .post(`/api/v1/patients/${patientA.id}/treatment-plans`)
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ notes: 'Plan de pagos' })
        .expect(201);
      const plan = createPlan.body as TreatmentPlanResponseBody;
      expect(plan.currency).toBe('USD');

      // --- 2. Add 3 items: one will become ACCEPTED, one DONE, one stays
      // PROPOSED (not billable -- see GetPlanBalanceUseCase.BILLABLE_STATUSES).
      const addItem = async (
        toothNumber: string,
      ): Promise<TreatmentPlanItemResponseBody> => {
        const res = await request(app.getHttpServer())
          .post(`/api/v1/treatment-plans/${plan.id}/items`)
          .set('X-Tenant-Host', hostFor(clinicA.subdomain))
          .set('Authorization', `Bearer ${clinicA.accessToken}`)
          .send({ toothNumber, catalogItemId: catalogItem.id })
          .expect(201);
        return res.body as TreatmentPlanItemResponseBody;
      };

      const itemAccepted = await addItem('11');
      const itemDone = await addItem('21');
      await addItem('31'); // stays PROPOSED

      await request(app.getHttpServer())
        .patch(`/api/v1/treatment-plans/${plan.id}/items/${itemAccepted.id}`)
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ status: 'ACCEPTED' })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/treatment-plans/${plan.id}/items/${itemDone.id}`)
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ status: 'DONE' })
        .expect(200);

      // --- 3. GET balance -> billable = 100 (ACCEPTED) + 100 (DONE) = 200
      // (PROPOSED item excluded); no payments yet -> paid=0, balance=200.
      const balance1 = await request(app.getHttpServer())
        .get(`/api/v1/treatment-plans/${plan.id}/balance`)
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      const balanceBody1 = balance1.body as PlanBalanceResponseBody;
      expect(balanceBody1.planCurrency).toBe('USD');
      expect(balanceBody1.billable).toBe(200);
      expect(balanceBody1.paid).toBe(0);
      expect(balanceBody1.balance).toBe(200);
      expect(balanceBody1.paymentsCount).toBe(0);

      // --- 4. POST an abono in the plan's own currency (USD 50) ->
      // createdById sourced from JWT; balance drops by 50.
      const paymentUsd = await request(app.getHttpServer())
        .post(`/api/v1/treatment-plans/${plan.id}/payments`)
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({
          amount: 50,
          currency: 'usd',
          paidAt: `${RATE_DATE}T09:00:00.000Z`,
          method: 'CASH',
        })
        .expect(201);
      const paymentUsdBody = paymentUsd.body as PaymentResponseBody;
      expect(paymentUsdBody.currency).toBe('USD');
      expect(paymentUsdBody.patientId).toBe(patientA.id);

      const balance2 = await request(app.getHttpServer())
        .get(`/api/v1/treatment-plans/${plan.id}/balance`)
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      const balanceBody2 = balance2.body as PlanBalanceResponseBody;
      expect(balanceBody2.paid).toBe(50);
      expect(balanceBody2.balance).toBe(150);
      expect(balanceBody2.paymentsCount).toBe(1);

      // --- 5. POST an abono in a DIFFERENT currency (COP 200000, on
      // RATE_DATE) -> converted via the seeded snapshot: 200000 / 4000 = 50
      // USD. Balance drops by the converted amount, not the raw COP amount.
      const paymentCop = await request(app.getHttpServer())
        .post(`/api/v1/treatment-plans/${plan.id}/payments`)
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({
          amount: 200000,
          currency: 'COP',
          paidAt: `${RATE_DATE}T10:00:00.000Z`,
          method: 'CASH',
        })
        .expect(201);
      const paymentCopBody = paymentCop.body as PaymentResponseBody;
      expect(paymentCopBody.currency).toBe('COP');

      const balance3 = await request(app.getHttpServer())
        .get(`/api/v1/treatment-plans/${plan.id}/balance`)
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      const balanceBody3 = balance3.body as PlanBalanceResponseBody;
      expect(balanceBody3.paid).toBe(100); // 50 (USD) + 50 (200000 COP converted)
      expect(balanceBody3.balance).toBe(100); // 200 - 100
      expect(balanceBody3.paymentsCount).toBe(2);

      // --- 6. GET /treatment-plans/:id/payments -> both abonos listed.
      const list = await request(app.getHttpServer())
        .get(`/api/v1/treatment-plans/${plan.id}/payments`)
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      const listBody = list.body as PaymentResponseBody[];
      expect(listBody.map((p) => p.id).sort()).toEqual(
        [paymentUsdBody.id, paymentCopBody.id].sort(),
      );

      // --- 7. DELETE /payments/:id (anular the COP one) -> balance rises
      // back to 150; a voided payment is soft-deleted, never hard-deleted.
      await request(app.getHttpServer())
        .delete(`/api/v1/payments/${paymentCopBody.id}`)
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);

      const balance4 = await request(app.getHttpServer())
        .get(`/api/v1/treatment-plans/${plan.id}/balance`)
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      const balanceBody4 = balance4.body as PlanBalanceResponseBody;
      expect(balanceBody4.paid).toBe(50);
      expect(balanceBody4.balance).toBe(150);
      expect(balanceBody4.paymentsCount).toBe(1);

      const list2 = await request(app.getHttpServer())
        .get(`/api/v1/treatment-plans/${plan.id}/payments`)
        .set('X-Tenant-Host', hostFor(clinicA.subdomain))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      expect((list2.body as PaymentResponseBody[]).map((p) => p.id)).toEqual([
        paymentUsdBody.id,
      ]);

      // --- 8. Tenant isolation: clinic B (different subdomain) cannot see
      // or void clinic A's data. Both GetPlanBalanceUseCase AND
      // ListPaymentsUseCase resolve the plan via GetTreatmentPlanUseCase
      // FIRST (404 parity, IMP-3), which throws NotFoundException for a
      // cross-tenant plan id -> 404 (RLS makes it indistinguishable from
      // absent) -- clinic B never even reaches `repo.listByPlan`, so it
      // gets 404, never a `200 []` that could be confused with "plan exists
      // but has no payments".
      const subdomainB = 'clinica-pay-b';
      const clinicB = await registerAndLogin(app, {
        clinicName: 'Clinica Pagos B',
        subdomain: subdomainB,
        email: 'owner@clinica-pay-b.com',
      });

      await request(app.getHttpServer())
        .get(`/api/v1/treatment-plans/${plan.id}/payments`)
        .set('X-Tenant-Host', hostFor(subdomainB))
        .set('Authorization', `Bearer ${clinicB.accessToken}`)
        .expect(404);

      await request(app.getHttpServer())
        .get(`/api/v1/treatment-plans/${plan.id}/balance`)
        .set('X-Tenant-Host', hostFor(subdomainB))
        .set('Authorization', `Bearer ${clinicB.accessToken}`)
        .expect(404);

      await request(app.getHttpServer())
        .delete(`/api/v1/payments/${paymentUsdBody.id}`)
        .set('X-Tenant-Host', hostFor(subdomainB))
        .set('Authorization', `Bearer ${clinicB.accessToken}`)
        .expect(404);

      // The payment must still be active for clinic A after B's failed void.
      const balance5 = await request(app.getHttpServer())
        .get(`/api/v1/treatment-plans/${plan.id}/balance`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      expect((balance5.body as PlanBalanceResponseBody).paymentsCount).toBe(1);

      // --- 9. Roles: DENTIST is not in PAYMENT_ROLES -> 403; ADMIN (already
      // proven above) + a seeded RECEPTION -> allowed.
      await seedRoledMember(
        clinicA.tenantId,
        'dentist@clinica-pay-a.com',
        ClinicRole.DENTIST,
        'Seeded DENTIST',
      );
      const dentistToken = await loginAs(app, {
        subdomain: subdomainA,
        email: 'dentist@clinica-pay-a.com',
      });

      await request(app.getHttpServer())
        .post(`/api/v1/treatment-plans/${plan.id}/payments`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${dentistToken}`)
        .send({
          amount: 10,
          currency: 'USD',
          paidAt: `${RATE_DATE}T11:00:00.000Z`,
        })
        .expect(403);

      await request(app.getHttpServer())
        .get(`/api/v1/treatment-plans/${plan.id}/balance`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${dentistToken}`)
        .expect(403);

      await seedRoledMember(
        clinicA.tenantId,
        'reception@clinica-pay-a.com',
        ClinicRole.RECEPTION,
        'Seeded RECEPTION',
      );
      const receptionToken = await loginAs(app, {
        subdomain: subdomainA,
        email: 'reception@clinica-pay-a.com',
      });

      const receptionPayment = await request(app.getHttpServer())
        .post(`/api/v1/treatment-plans/${plan.id}/payments`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${receptionToken}`)
        .send({
          amount: 25,
          currency: 'USD',
          paidAt: `${RATE_DATE}T12:00:00.000Z`,
        })
        .expect(201);
      expect((receptionPayment.body as PaymentResponseBody).amount).toBe(25);

      await request(app.getHttpServer())
        .get(`/api/v1/treatment-plans/${plan.id}/balance`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${receptionToken}`)
        .expect(200);
    },
  );
});
