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

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para seed/cleanup — usa
// DIRECT_URL (rol owner `dentalix`, superuser) porque, con RLS aplicado, una
// conexión sin contexto de tenant (rol dentalix_app vía DATABASE_URL) ve 0
// filas y no podría sembrar/limpiar datos ajenos al tenant. Ver
// appointments.e2e-spec.ts / role-matrix.e2e-spec.ts para el mismo patrón.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const SEEDED_PASSWORD = 'S3cret!!';

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
}

interface CatalogItemResponseBody {
  id: string;
  defaultPrice: number | null;
}

interface TreatmentPlanResponseBody {
  id: string;
  tenantId: string;
  patientId: string;
  status: string;
  notes: string | null;
  createdById: string | null;
}

interface TreatmentPlanItemResponseBody {
  id: string;
  planId: string;
  toothNumber: string;
  catalogItemId: string;
  price: number;
  status: string;
}

interface TreatmentPlanDetailResponseBody extends TreatmentPlanResponseBody {
  items: TreatmentPlanItemResponseBody[];
  total: number;
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
      firstName: 'Plan',
      lastName: 'Tratamiento',
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
// invitación de staff todavía (mismo patrón que appointments.e2e-spec.ts /
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

describe('Treatment plans (e2e)', () => {
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
    // FK-safe order: treatment_plan_items -> treatment_plans ->
    // dental_catalog_items -> patients -> memberships -> users -> tenants
    // (same convention as appointments.e2e-spec.ts / role-matrix.e2e-spec.ts).
    // tooth_records referencia patients (y plan items): marcar un ítem de plan
    // como DONE crea un ToothRecord, así que se borran ANTES o el delete de
    // patients falla por FK y hace reventar el afterAll (contaminando las
    // suites siguientes).
    await raw.toothRecord.deleteMany();
    await raw.treatmentPlanItem.deleteMany();
    await raw.treatmentPlan.deleteMany();
    await raw.dentalCatalogItem.deleteMany();
    await raw.patient.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
  });

  afterAll(async () => {
    // tooth_records referencia patients (y plan items): marcar un ítem de plan
    // como DONE crea un ToothRecord, así que se borran ANTES o el delete de
    // patients falla por FK y hace reventar el afterAll (contaminando las
    // suites siguientes).
    await raw.toothRecord.deleteMany();
    await raw.treatmentPlanItem.deleteMany();
    await raw.treatmentPlan.deleteMany();
    await raw.dentalCatalogItem.deleteMany();
    await raw.patient.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
    await app.close();
    await raw.$disconnect();
  });

  it('creates a plan, adds items (default + explicit price), computes total, updates/soft-deletes items, updates plan status, isolates tenants, and blocks reception', async () => {
    const subdomainA = 'clinica-tp-a';
    const clinicA = await registerAndLogin(app, {
      clinicName: 'Clinica TP A',
      subdomain: subdomainA,
      email: 'owner@clinica-tp-a.com',
    });
    const patientA = await createPatient(
      app,
      clinicA.accessToken,
      clinicA.subdomain,
      '9001',
    );

    // --- 0. Seed a PROCEDURE catalog item with a known defaultPrice.
    const createCatalogItem = await request(app.getHttpServer())
      .post('/api/v1/catalog/items')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        code: 'RESINA-001',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Resina',
        color: '#2A2B3C',
        defaultPrice: 100,
      })
      .expect(201);
    const catalogItem = createCatalogItem.body as CatalogItemResponseBody;
    expect(catalogItem.defaultPrice).toBe(100);

    // --- 1. Create plan -> 201, status DRAFT.
    const createPlan = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientA.id}/treatment-plans`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ notes: 'Plan inicial' })
      .expect(201);
    const plan = createPlan.body as TreatmentPlanResponseBody;
    expect(plan.status).toBe('DRAFT');
    expect(plan.patientId).toBe(patientA.id);
    // createdById is sourced from the JWT, never the client body.
    expect(plan.createdById).toBe(clinicA.userId);

    // --- 2. Add item WITHOUT price -> uses catalog defaultPrice (100).
    const addItem1 = await request(app.getHttpServer())
      .post(`/api/v1/treatment-plans/${plan.id}/items`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        toothNumber: '11',
        catalogItemId: catalogItem.id,
      })
      .expect(201);
    const item1 = addItem1.body as TreatmentPlanItemResponseBody;
    expect(item1.price).toBe(100);
    expect(item1.status).toBe('PROPOSED');

    // --- 3. Add item WITH explicit price (overrides defaultPrice).
    const addItem2 = await request(app.getHttpServer())
      .post(`/api/v1/treatment-plans/${plan.id}/items`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        toothNumber: '21',
        catalogItemId: catalogItem.id,
        price: 50,
      })
      .expect(201);
    const item2 = addItem2.body as TreatmentPlanItemResponseBody;
    expect(item2.price).toBe(50);

    // --- 4. GET plan -> items present, total == sum (150).
    const getPlan1 = await request(app.getHttpServer())
      .get(`/api/v1/treatment-plans/${plan.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const planDetail1 = getPlan1.body as TreatmentPlanDetailResponseBody;
    expect(planDetail1.items.map((i) => i.id).sort()).toEqual(
      [item1.id, item2.id].sort(),
    );
    expect(planDetail1.total).toBe(150);

    // --- 5. Add item with INVALID toothNumber -> 400 (FDI validation at the
    // HTTP boundary).
    await request(app.getHttpServer())
      .post(`/api/v1/treatment-plans/${plan.id}/items`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        toothNumber: '99',
        catalogItemId: catalogItem.id,
      })
      .expect(400);

    // --- 6. PATCH item1 status -> DONE, reflected on GET.
    await request(app.getHttpServer())
      .patch(`/api/v1/treatment-plans/${plan.id}/items/${item1.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ status: 'DONE' })
      .expect(200);

    const getPlan2 = await request(app.getHttpServer())
      .get(`/api/v1/treatment-plans/${plan.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const planDetail2 = getPlan2.body as TreatmentPlanDetailResponseBody;
    expect(planDetail2.items.find((i) => i.id === item1.id)?.status).toBe(
      'DONE',
    );

    // --- 7. DELETE item2 (soft) -> GET no longer lists it, total drops.
    await request(app.getHttpServer())
      .delete(`/api/v1/treatment-plans/${plan.id}/items/${item2.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);

    const getPlan3 = await request(app.getHttpServer())
      .get(`/api/v1/treatment-plans/${plan.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const planDetail3 = getPlan3.body as TreatmentPlanDetailResponseBody;
    expect(planDetail3.items.map((i) => i.id)).not.toContain(item2.id);
    expect(planDetail3.total).toBe(100);

    // --- 8. PATCH plan status -> ACCEPTED, reflected on GET.
    await request(app.getHttpServer())
      .patch(`/api/v1/treatment-plans/${plan.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ status: 'ACCEPTED' })
      .expect(200);

    const getPlan4 = await request(app.getHttpServer())
      .get(`/api/v1/treatment-plans/${plan.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    expect((getPlan4.body as TreatmentPlanDetailResponseBody).status).toBe(
      'ACCEPTED',
    );

    // --- 9. Tenant isolation: clinic B (2nd owner, different subdomain) does
    // not see clinic A's plan -> 404 (RLS makes a cross-tenant row
    // indistinguishable from absent, see GetTreatmentPlanUseCase).
    const subdomainB = 'clinica-tp-b';
    const clinicB = await registerAndLogin(app, {
      clinicName: 'Clinica TP B',
      subdomain: subdomainB,
      email: 'owner@clinica-tp-b.com',
    });

    await request(app.getHttpServer())
      .get(`/api/v1/treatment-plans/${plan.id}`)
      .set('X-Tenant-Host', hostFor(clinicB.subdomain))
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .expect(404);

    // --- 10. RECEPTION 403 on any treatment-plans route; ADMIN/DENTIST OK.
    await seedRoledMember(
      clinicA.tenantId,
      'reception@clinica-tp-a.com',
      ClinicRole.RECEPTION,
      'Seeded RECEPTION',
    );
    const receptionToken = await loginAs(app, {
      subdomain: subdomainA,
      email: 'reception@clinica-tp-a.com',
    });

    await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientA.id}/treatment-plans`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${receptionToken}`)
      .send({ notes: 'Intento recepcion' })
      .expect(403);

    await request(app.getHttpServer())
      .get(`/api/v1/treatment-plans/${plan.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${receptionToken}`)
      .expect(403);

    await seedRoledMember(
      clinicA.tenantId,
      'dentist@clinica-tp-a.com',
      ClinicRole.DENTIST,
      'Seeded DENTIST',
    );
    const dentistToken = await loginAs(app, {
      subdomain: subdomainA,
      email: 'dentist@clinica-tp-a.com',
    });

    await request(app.getHttpServer())
      .get(`/api/v1/treatment-plans/${plan.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${dentistToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientA.id}/treatment-plans`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${dentistToken}`)
      .send({ notes: 'Plan de dentista' })
      .expect(201);

    // ADMIN sanity: not-deny-all.
    await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}/treatment-plans`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
  });
});
