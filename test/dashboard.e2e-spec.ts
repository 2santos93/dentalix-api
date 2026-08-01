import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para seed/cleanup -- usa
// DIRECT_URL (rol owner `dentalix`, superuser) porque, con RLS aplicado, una
// conexión sin contexto de tenant (rol dentalix_app vía DATABASE_URL) ve 0
// filas y no podría sembrar/limpiar datos ajenos al tenant. Mismo patrón que
// sales.e2e-spec.ts / inventory.e2e-spec.ts / role-matrix.e2e-spec.ts.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const SEEDED_PASSWORD = 'S3cret!!';

// The date this suite seeds an exchange snapshot for. EXCHANGE_APP_ID is
// blank in .env.test (see .env.test / exchange.e2e-spec.ts), so if
// GetPaymentsTotalsUseCase (invoked via GetDoctorDashboardUseCase) ever fell
// through to the live provider it would throw instead of silently hitting
// the network -- the seeded payment below is in COP, so it must hit the
// seeded snapshot for RATE_DATE, never OpenExchangeRatesProvider.
const RATE_DATE = '2026-05-15';
const RATE_COP = 4000;
const FROM = '2026-05-15';
const TO = '2026-05-16'; // half-open [from, to) -- covers all of RATE_DATE

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

interface InventoryItemResponseBody {
  id: string;
  name: string;
}

interface AppointmentResponseBody {
  id: string;
  start: string;
  end: string;
}

interface DashboardIncomesBody {
  currency: string;
  totalConverted: number;
  count: number;
  byCurrency: Record<string, number>;
}

interface DashboardLowStockBody {
  count: number;
  items: Array<{ id: string; name: string }>;
}

interface DashboardUpcomingAppointmentBody {
  id: string;
  patientId: string;
  providerId: string;
  start: string;
  end: string;
  status: string;
}

interface DashboardResponseBody {
  period: { from: string; to: string };
  incomes: DashboardIncomesBody;
  lowStockItems: DashboardLowStockBody;
  upcomingAppointments: DashboardUpcomingAppointmentBody[];
  patientCount: number;
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

// Siembra un usuario con contraseña hasheada igual que el registro, más su
// membresía en la clínica (tenant) dada, con el rol pedido. Usa el cliente
// `raw` (DIRECT_URL, superuser) porque bypassa RLS -- no hay endpoint de
// invitación de staff todavía (mismo patrón que sales.e2e-spec.ts /
// inventory.e2e-spec.ts / role-matrix.e2e-spec.ts).
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
  // FK-safe order: InventoryMovement -> InventoryItem (onDelete: Restrict) ->
  // Appointment -> Patient -> ClinicMembership -> User -> Tenant, plus the
  // exchange snapshot this suite seeds directly. Payment -> TreatmentPlan
  // (onDelete: Restrict) must be cleared before Patient too -- Sale/
  // SaleLineItem were dropped by the payments pivot (see
  // docs/plans/2026-07-24-payments-pivot.md); this suite now seeds a
  // TreatmentPlan + Payment directly (raw/DIRECT_URL, no REST yet -- PAY-T3)
  // for the `dash.incomes.*` assertions.
  // tooth_records referencia patients (y plan items): marcar un ítem de plan
  // como DONE crea un ToothRecord, así que se borran ANTES o el delete de
  // patients falla por FK y hace reventar el afterAll (contaminando las
  // suites siguientes).
  await raw.toothRecord.deleteMany();
  await raw.payment.deleteMany();
  await raw.treatmentPlan.deleteMany();
  await raw.inventoryMovement.deleteMany();
  await raw.inventoryItem.deleteMany();
  await raw.appointment.deleteMany();
  await raw.patient.deleteMany();
  await raw.clinicMembership.deleteMany();
  await raw.user.deleteMany();
  await raw.tenant.deleteMany();
  await raw.exchangeRateSnapshot.deleteMany({ where: { date: RATE_DATE } });
}

describe('Dashboard (e2e)', () => {
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

    // Seed the COP snapshot directly via DIRECT_URL so
    // GetPaymentsTotalsUseCase -> ConvertAmountUseCase -> GetRatesForDateUseCase's
    // cache-then-fetch finds a row for RATE_DATE and returns immediately
    // (cache hit) -- it never calls OpenExchangeRatesProvider.fetchRates, so
    // this suite needs no network access and no real EXCHANGE_APP_ID.
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
    'aggregates converted incomes + low-stock items + upcoming appointments + ' +
      'patient count offline, isolates tenants and enforces DASHBOARD_ROLES',
    async () => {
      const subdomainA = 'clinica-dash-a';
      const clinicA = await registerAndLogin(app, {
        clinicName: 'Clinica Dashboard A',
        subdomain: subdomainA,
        email: 'owner@clinica-dash-a.com',
      });

      // --- 1. Seed a patient.
      const patientRes = await request(app.getHttpServer())
        .post('/api/v1/patients')
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({
          firstName: 'Dash',
          lastName: 'Board',
          docType: 'CC',
          docNumber: 'DASH-A-001',
          sex: 'F',
        })
        .expect(201);
      const patient = patientRes.body as PatientResponseBody;

      // --- 2. Seed a treatment plan (raw/DIRECT_URL -- no payments REST yet,
      // that's PAY-T3) then a COP payment against it on RATE_DATE -- converts
      // offline via the seeded snapshot (500000 / 4000 = 125 USD).
      // GetPaymentsTotalsUseCase (invoked via GetDoctorDashboardUseCase) sums
      // every active payment in [from,to) regardless of which plan it
      // belongs to, so a bare plan row (no items) is enough here.
      const plan = await raw.treatmentPlan.create({
        data: {
          tenantId: clinicA.tenantId,
          patientId: patient.id,
          currency: 'USD',
        },
        select: { id: true },
      });
      // El pago se siembra por Prisma (no hay REST de pagos en este spec), así
      // que hay que darle su sede: multi-sede hizo `locationId` obligatorio.
      // Se toma la "Sede principal" que el registro de la clínica ya creó.
      const locationA = await raw.location.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId },
        select: { id: true },
      });
      await raw.payment.create({
        data: {
          tenantId: clinicA.tenantId,
          locationId: locationA.id,
          treatmentPlanId: plan.id,
          patientId: patient.id,
          amount: 500000,
          currency: 'COP',
          paidAt: new Date(`${RATE_DATE}T10:00:00.000Z`),
          method: 'CASH',
        },
      });

      // --- 3. Seed an inventory item with no movements -> stock 0,
      // minStock default 0 is NOT low stock, so give it minStock 1 to force
      // stock(0) <= minStock(1) => lowStock true (same convention as
      // inventory.e2e-spec.ts step 2).
      const itemRes = await request(app.getHttpServer())
        .post('/api/v1/inventory/items')
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ name: 'Guantes de nitrilo', unit: 'caja', minStock: 1 })
        .expect(201);
      const item = itemRes.body as InventoryItemResponseBody;

      // --- 4. Seed a FUTURE appointment (provider = owner's userId; no
      // staff-invitation endpoint yet, so the owner doubles as provider --
      // CreateAppointmentUseCase never validates providerId against
      // ClinicMembership, only overlap).
      const futureStart = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
      const futureEnd = new Date(futureStart.getTime() + 30 * 60 * 1000);
      const apptRes = await request(app.getHttpServer())
        .post('/api/v1/appointments')
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({
          patientId: patient.id,
          providerId: clinicA.userId,
          start: futureStart.toISOString(),
          end: futureEnd.toISOString(),
          reason: 'Control',
        })
        .expect(201);
      const appointment = apptRes.body as AppointmentResponseBody;

      // --- 5. GET /dashboard?from&to&currency=USD&upcomingLimit=5 ->
      // aggregates all 4 metrics for clinic A.
      const dashRes = await request(app.getHttpServer())
        .get(
          `/api/v1/dashboard?from=${FROM}&to=${TO}&currency=usd&upcomingLimit=5`,
        )
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      const dash = dashRes.body as DashboardResponseBody;

      expect(dash.incomes.currency).toBe('USD');
      expect(dash.incomes.count).toBeGreaterThanOrEqual(1);
      expect(dash.incomes.totalConverted).toBe(125);
      expect(dash.incomes.byCurrency).toEqual({ COP: 500000 });

      expect(dash.lowStockItems.count).toBeGreaterThanOrEqual(1);
      expect(dash.lowStockItems.items.map((i) => i.id)).toContain(item.id);

      expect(
        dash.upcomingAppointments.map((a) => ({
          id: a.id,
          start: a.start,
        })),
      ).toContainEqual({ id: appointment.id, start: appointment.start });

      expect(dash.patientCount).toBeGreaterThanOrEqual(1);

      // --- 6. Isolation: clinic B (different subdomain) sees its OWN
      // empty/zero metrics over the SAME range -- never clinic A's data
      // (RLS scopes every reused use case by tenant, see
      // multi-tenancy rule / sales.e2e-spec.ts step 7).
      const subdomainB = 'clinica-dash-b';
      const clinicB = await registerAndLogin(app, {
        clinicName: 'Clinica Dashboard B',
        subdomain: subdomainB,
        email: 'owner@clinica-dash-b.com',
      });

      const dashResB = await request(app.getHttpServer())
        .get(`/api/v1/dashboard?from=${FROM}&to=${TO}&currency=USD`)
        .set('X-Tenant-Host', hostFor(subdomainB))
        .set('Authorization', `Bearer ${clinicB.accessToken}`)
        .expect(200);
      const dashB = dashResB.body as DashboardResponseBody;

      expect(dashB.incomes.count).toBe(0);
      expect(dashB.incomes.totalConverted).toBe(0);
      expect(dashB.lowStockItems.count).toBe(0);
      expect(dashB.lowStockItems.items).toEqual([]);
      expect(dashB.upcomingAppointments).toEqual([]);
      expect(dashB.patientCount).toBe(0);

      // --- 7. Roles: DENTIST and RECEPTION are not in DASHBOARD_ROLES ->
      // 403; ADMIN (already proven above via clinicA) -> 200.
      await seedRoledMember(
        clinicA.tenantId,
        'dentist@clinica-dash-a.com',
        ClinicRole.DENTIST,
        'Seeded DENTIST',
      );
      const dentistToken = await loginAs(app, {
        subdomain: subdomainA,
        email: 'dentist@clinica-dash-a.com',
      });

      await request(app.getHttpServer())
        .get(`/api/v1/dashboard?from=${FROM}&to=${TO}&currency=USD`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${dentistToken}`)
        .expect(403);

      await seedRoledMember(
        clinicA.tenantId,
        'reception@clinica-dash-a.com',
        ClinicRole.RECEPTION,
        'Seeded RECEPTION',
      );
      const receptionToken = await loginAs(app, {
        subdomain: subdomainA,
        email: 'reception@clinica-dash-a.com',
      });

      await request(app.getHttpServer())
        .get(`/api/v1/dashboard?from=${FROM}&to=${TO}&currency=USD`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${receptionToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .get(`/api/v1/dashboard?from=${FROM}&to=${TO}&currency=USD`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
    },
  );
});
