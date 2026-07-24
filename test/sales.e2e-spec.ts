import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para seed/cleanup — usa
// DIRECT_URL (rol owner `dentalix`, superuser) porque, con RLS aplicado, una
// conexión sin contexto de tenant (rol dentalix_app vía DATABASE_URL) ve 0
// filas y no podría sembrar/limpiar datos ajenos al tenant. Ver
// treatment-plans.e2e-spec.ts / role-matrix.e2e-spec.ts para el mismo
// patrón. Igual que exchange.e2e-spec.ts para el seed del snapshot.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const SEEDED_PASSWORD = 'S3cret!!';

// The date this suite seeds an exchange snapshot for. EXCHANGE_APP_ID is
// blank in .env.test (see .env.test / exchange.e2e-spec.ts), so if
// GetSalesTotalsUseCase ever fell through to the live provider it would
// throw instead of silently hitting the network -- every conversion below
// must hit either the seeded snapshot (COP) or the from===to passthrough
// (USD), never OpenExchangeRatesProvider.
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

interface SaleLineItemResponseBody {
  id: string;
  saleId: string;
  description: string;
  unitPrice: number;
  quantity: number;
  amount: number;
}

interface SaleResponseBody {
  id: string;
  currency: string;
  total: number;
  paidAt: string;
  lineItems?: SaleLineItemResponseBody[];
}

interface SalesTotalsResponseBody {
  currency: string;
  totalConverted: number;
  count: number;
  byCurrency: Record<string, number>;
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
// invitación de staff todavía (mismo patrón que treatment-plans.e2e-spec.ts /
// role-matrix.e2e-spec.ts).
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
  // FK-safe order: SaleLineItem -> Sale (onDelete: Restrict) -> Patient
  // (Sale.patientId FK) -> ClinicMembership -> User -> Tenant.
  await raw.saleLineItem.deleteMany();
  await raw.sale.deleteMany();
  await raw.patient.deleteMany();
  await raw.clinicMembership.deleteMany();
  await raw.user.deleteMany();
  await raw.tenant.deleteMany();
  await raw.exchangeRateSnapshot.deleteMany({ where: { date: RATE_DATE } });
}

describe('Sales (e2e)', () => {
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
    // GetSalesTotalsUseCase -> ConvertAmountUseCase -> GetRatesForDateUseCase's
    // cache-then-fetch finds a row for RATE_DATE and returns immediately
    // (cache hit) -- it never calls OpenExchangeRatesProvider.fetchRates, so
    // this suite needs no network access and no real EXCHANGE_APP_ID. The
    // USD sale below never needs this snapshot at all: `from === to` is a
    // passthrough in ConvertAmountUseCase (see convert-amount.use-case.ts).
    await raw.exchangeRateSnapshot.create({
      data: { date: RATE_DATE, currency: 'COP', rate: RATE_COP },
    });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it('creates, lists, gets, converts totals for, voids and isolates sales; enforces SALES_ROLES', async () => {
    const subdomainA = 'clinica-sales-a';
    const clinicA = await registerAndLogin(app, {
      clinicName: 'Clinica Sales A',
      subdomain: subdomainA,
      email: 'owner@clinica-sales-a.com',
    });

    // --- 1. POST /sales in COP, 2 line items -> 201, total = sum of lines,
    // lines present on the response.
    const createCop = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('X-Tenant-Host', hostFor(subdomainA))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        currency: 'cop',
        paidAt: `${RATE_DATE}T10:00:00.000Z`,
        paymentMethod: 'CASH',
        notes: 'Consulta + limpieza',
        lineItems: [
          { description: 'Consulta', unitPrice: 200000, quantity: 1 },
          { description: 'Limpieza', unitPrice: 100000, quantity: 3 },
        ],
      })
      .expect(201);
    const saleCop = createCop.body as SaleResponseBody;
    expect(saleCop.currency).toBe('COP');
    expect(saleCop.total).toBe(500000);
    expect(saleCop.lineItems).toHaveLength(2);
    expect(saleCop.lineItems?.map((l) => l.amount).sort()).toEqual([
      200000, 300000,
    ]);

    // --- 2. POST /sales in USD (a single-line sale, same day) -> 201.
    const createUsd = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('X-Tenant-Host', hostFor(subdomainA))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        currency: 'USD',
        paidAt: `${RATE_DATE}T12:00:00.000Z`,
        paymentMethod: 'CARD',
        lineItems: [{ description: 'Servicio', unitPrice: 30, quantity: 1 }],
      })
      .expect(201);
    const saleUsd = createUsd.body as SaleResponseBody;
    expect(saleUsd.currency).toBe('USD');
    expect(saleUsd.total).toBe(30);

    // --- 3. GET /sales -> both, ordered paidAt DESC (USD at 12:00 before
    // COP at 10:00, same day).
    const list1 = await request(app.getHttpServer())
      .get('/api/v1/sales')
      .set('X-Tenant-Host', hostFor(subdomainA))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const sales1 = list1.body as SaleResponseBody[];
    expect(sales1.map((s) => s.id)).toEqual([saleUsd.id, saleCop.id]);

    // --- 4. GET /sales/:id -> sale + line items.
    const getCop = await request(app.getHttpServer())
      .get(`/api/v1/sales/${saleCop.id}`)
      .set('X-Tenant-Host', hostFor(subdomainA))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const getCopBody = getCop.body as SaleResponseBody;
    expect(getCopBody.lineItems).toHaveLength(2);

    // --- 5. GET /sales/totals?currency=USD -> COP sale converted at 4000
    // for RATE_DATE (500000 / 4000 = 125) + USD sale as-is (30) = 155;
    // byCurrency has both; count = 2. Range is half-open [from, to).
    const totals1 = await request(app.getHttpServer())
      .get(
        `/api/v1/sales/totals?from=${RATE_DATE}T00:00:00.000Z&to=2026-07-02T00:00:00.000Z&currency=usd`,
      )
      .set('X-Tenant-Host', hostFor(subdomainA))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const totalsBody1 = totals1.body as SalesTotalsResponseBody;
    expect(totalsBody1.currency).toBe('USD');
    expect(totalsBody1.count).toBe(2);
    expect(totalsBody1.totalConverted).toBe(155);
    expect(totalsBody1.byCurrency).toEqual({ COP: 500000, USD: 30 });

    // --- 6. DELETE /sales/:id (void the COP one) -> then GET /sales
    // excludes it, GET /sales/totals drops it accordingly.
    await request(app.getHttpServer())
      .delete(`/api/v1/sales/${saleCop.id}`)
      .set('X-Tenant-Host', hostFor(subdomainA))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);

    const list2 = await request(app.getHttpServer())
      .get('/api/v1/sales')
      .set('X-Tenant-Host', hostFor(subdomainA))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const sales2 = list2.body as SaleResponseBody[];
    expect(sales2.map((s) => s.id)).toEqual([saleUsd.id]);

    const totals2 = await request(app.getHttpServer())
      .get(
        `/api/v1/sales/totals?from=${RATE_DATE}T00:00:00.000Z&to=2026-07-02T00:00:00.000Z&currency=USD`,
      )
      .set('X-Tenant-Host', hostFor(subdomainA))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const totalsBody2 = totals2.body as SalesTotalsResponseBody;
    expect(totalsBody2.count).toBe(1);
    expect(totalsBody2.totalConverted).toBe(30);
    expect(totalsBody2.byCurrency).toEqual({ USD: 30 });

    // A voided sale is soft-deleted, never hard-deleted -- GET /sales/:id on
    // it now 404s the same way a cross-tenant row does (see GetSaleUseCase).
    await request(app.getHttpServer())
      .get(`/api/v1/sales/${saleCop.id}`)
      .set('X-Tenant-Host', hostFor(subdomainA))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(404);

    // --- 7. Tenant isolation: clinic B (different subdomain) does not see
    // clinic A's remaining sale -> 404 (RLS makes a cross-tenant row
    // indistinguishable from absent, see GetSaleUseCase).
    const subdomainB = 'clinica-sales-b';
    const clinicB = await registerAndLogin(app, {
      clinicName: 'Clinica Sales B',
      subdomain: subdomainB,
      email: 'owner@clinica-sales-b.com',
    });

    await request(app.getHttpServer())
      .get(`/api/v1/sales/${saleUsd.id}`)
      .set('X-Tenant-Host', hostFor(subdomainB))
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .expect(404);

    // --- 8. Roles: DENTIST is not in SALES_ROLES -> 403 on POST and GET;
    // OWNER (already proven above) + a seeded RECEPTION -> OK.
    await seedRoledMember(
      clinicA.tenantId,
      'dentist@clinica-sales-a.com',
      ClinicRole.DENTIST,
      'Seeded DENTIST',
    );
    const dentistToken = await loginAs(app, {
      subdomain: subdomainA,
      email: 'dentist@clinica-sales-a.com',
    });

    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('X-Tenant-Host', hostFor(subdomainA))
      .set('Authorization', `Bearer ${dentistToken}`)
      .send({
        currency: 'USD',
        paidAt: `${RATE_DATE}T09:00:00.000Z`,
        lineItems: [{ description: 'Intento dentista', unitPrice: 1, quantity: 1 }],
      })
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/sales')
      .set('X-Tenant-Host', hostFor(subdomainA))
      .set('Authorization', `Bearer ${dentistToken}`)
      .expect(403);

    await seedRoledMember(
      clinicA.tenantId,
      'reception@clinica-sales-a.com',
      ClinicRole.RECEPTION,
      'Seeded RECEPTION',
    );
    const receptionToken = await loginAs(app, {
      subdomain: subdomainA,
      email: 'reception@clinica-sales-a.com',
    });

    await request(app.getHttpServer())
      .get('/api/v1/sales')
      .set('X-Tenant-Host', hostFor(subdomainA))
      .set('Authorization', `Bearer ${receptionToken}`)
      .expect(200);

    const receptionCreate = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('X-Tenant-Host', hostFor(subdomainA))
      .set('Authorization', `Bearer ${receptionToken}`)
      .send({
        currency: 'USD',
        paidAt: `${RATE_DATE}T09:00:00.000Z`,
        lineItems: [
          { description: 'Cobro recepcion', unitPrice: 5, quantity: 2 },
        ],
      })
      .expect(201);
    expect((receptionCreate.body as SaleResponseBody).total).toBe(10);
  });
});
