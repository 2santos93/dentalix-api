import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaProductionByProcedureRepository } from '../src/modules/reports/infrastructure/prisma-production-by-procedure.repository';
import { GetProductionByProcedureUseCase } from '../src/modules/reports/application/use-cases/get-production-by-procedure.use-case';
import { resetDatabase } from './support/e2e-fixtures';
import { ReportSeeder } from './support/reports-fixtures';

// DX-423 · las consultas de «Producción por procedimiento» contra Postgres de
// verdad, como dentalix_app (DATABASE_URL, sin BYPASSRLS) con la clínica
// fijada por runWithTenant. `raw` (DIRECT_URL, owner) solo siembra.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };

/** Lo que lee el reporte: todo con RLS FORZADA por clínica. */
const SOURCE_TABLES = [
  'locations',
  'treatment_plans',
  'treatment_plan_items',
  'dental_catalog_items',
  'patients',
  'clinic_memberships',
];

interface SeededClinic {
  tenantId: string;
  main: string;
  other: string;
  catalogItemId: string;
  dentistId: string;
  otherDentistId: string;
}

async function seedClinic(
  subdomain: string,
  price: number,
): Promise<SeededClinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const seed = new ReportSeeder(raw, tenant.id);
  const main = await seed.location('Sede principal');
  const other = await seed.location('Sede B');
  const dentist = await seed.dentist();
  const otherDentistId = await seed.provider(`Otro ${subdomain}`);
  const otherMembership = await raw.clinicMembership.findFirstOrThrow({
    where: { tenantId: tenant.id, userId: otherDentistId },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: `RES-${subdomain}`,
      kind: 'PROCEDURE',
      labelEs: 'Resina',
      category: 'Operatoria',
      color: '#123456',
    },
  });
  const patientId = await seed.patient(subdomain);
  const done = async (
    locationId: string | null,
    by: { userId: string; id: string },
    completedAt: Date | null,
    amount: number,
  ) => {
    const plan = await raw.treatmentPlan.create({
      data: {
        tenantId: tenant.id,
        patientId,
        currency: 'COP',
        status: 'ACCEPTED',
      },
    });
    await raw.treatmentPlanItem.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        toothNumber: '16',
        catalogItemId: catalog.id,
        price: amount,
        basePrice: amount,
        status: 'DONE',
        performedById: by.userId,
        performedByMembershipId: by.id,
        performedLocationId: locationId,
        completedAt,
      },
    });
  };
  const at = new Date('2026-10-05T15:00:00Z');
  await done(main, dentist, at, price);
  await done(
    other,
    { userId: otherDentistId, id: otherMembership.id },
    at,
    price * 2,
  );
  await done(other, dentist, null, 7);
  return {
    tenantId: tenant.id,
    main,
    other,
    catalogItemId: catalog.id,
    dentistId: dentist.userId,
    otherDentistId,
  };
}

describe('Producción por procedimiento en la BD (DX-423, int)', () => {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const repo = new PrismaProductionByProcedureRepository(prisma, context);
  const useCase = new GetProductionByProcedureUseCase(repo);
  let a: SeededClinic;
  let b: SeededClinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(raw);
    a = await seedClinic('dx423-a', 100);
    b = await seedClinic('dx423-b', 5_000);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await raw.$disconnect();
  });

  it('corre como dentalix_app, sin BYPASSRLS', async () => {
    const [who] = await prisma.$queryRaw<
      { role: string; bypass: boolean }[]
    >`SELECT current_user AS role, rolbypassrls AS bypass
        FROM pg_roles WHERE rolname = current_user`;
    expect(who).toEqual({ role: 'dentalix_app', bypass: false });
  });

  it('las tablas que lee tienen RLS forzada', async () => {
    const rows = await raw.$queryRaw<
      { relname: string; enabled: boolean; forced: boolean }[]
    >`SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relname = ANY(${SOURCE_TABLES})`;
    expect(rows.map((r) => r.relname).sort()).toEqual(
      [...SOURCE_TABLES].sort(),
    );
    expect(rows.filter((r) => !r.enabled || !r.forced)).toEqual([]);
  });

  it('suma por procedimiento en la sede donde se realizó', async () => {
    const sums = await context.run(a.tenantId, () =>
      repo.aggregate(OCTOBER, { locationIds: [a.main, a.other] }),
    );
    expect(sums).toEqual([
      expect.objectContaining({
        catalogItemId: a.catalogItemId,
        category: 'Operatoria',
        currency: 'COP',
        count: 2,
        gross: 300,
        catalogCount: 2,
        catalogSum: 300,
      }),
    ]);
    const onlyMain = await context.run(a.tenantId, () =>
      repo.aggregate(OCTOBER, { locationIds: [a.main] }),
    );
    expect(onlyMain.map((s) => s.gross)).toEqual([100]);
  });

  it('con las sedes o el procedimiento de otra clínica no devuelve nada de ella', async () => {
    const sums = await context.run(a.tenantId, () =>
      repo.aggregate(OCTOBER, { locationIds: [b.main, b.other] }),
    );
    expect(sums).toEqual([]);
    const items = await context.run(a.tenantId, () =>
      repo.listItems(
        OCTOBER,
        { locationIds: [a.main, a.other], catalogItemId: b.catalogItemId },
        { skip: 0, take: 10 },
      ),
    );
    expect(items).toEqual({ items: [], total: 0 });
  });

  it('la RLS sola ya aísla: filtro explícito de B con la clínica A fijada → nada', async () => {
    const asB = new TenantContextService();
    const crossed = new PrismaProductionByProcedureRepository(prisma, asB);
    const [sums, pending, categories] = await context.run(a.tenantId, () =>
      asB.run(b.tenantId, () =>
        Promise.all([
          crossed.aggregate(OCTOBER, { locationIds: [b.main, b.other] }),
          crossed.unattributed({ locationIds: [b.main, b.other] }, true),
          crossed.listCategories(),
        ]),
      ),
    );
    expect(sums).toEqual([]);
    expect(pending).toEqual([]);
    // Ni las categorías del catálogo de B.
    expect(categories).toEqual([]);
  });

  it('rol: un DENTIST solo suma lo suyo; ADMIN, todo el equipo', async () => {
    const asDentist = await context.run(a.tenantId, () =>
      useCase.execute({
        ...OCTOBER,
        actor: { userId: a.dentistId, role: ClinicRole.DENTIST },
        allowedLocationIds: 'ALL',
      }),
    );
    expect(asDentist.totals).toEqual([
      {
        currency: 'COP',
        count: 1,
        gross: 100,
        discounts: 0,
        net: 100,
        averageNet: 100,
      },
    ]);
    expect(asDentist.unattributed).toEqual([
      { currency: 'COP', count: 1, gross: 7, discounts: 0, net: 7 },
    ]);
    const asAdmin = await context.run(a.tenantId, () =>
      useCase.execute({
        ...OCTOBER,
        actor: { userId: a.otherDentistId, role: ClinicRole.ADMIN },
        allowedLocationIds: 'ALL',
      }),
    );
    expect(asAdmin.totals[0]).toMatchObject({ count: 2, net: 300 });
  });

  it('sedes: un miembro restringido a la principal no ve lo de la otra sede', async () => {
    const restricted = await context.run(a.tenantId, () =>
      useCase.execute({
        ...OCTOBER,
        actor: { userId: a.dentistId, role: ClinicRole.ADMIN },
        allowedLocationIds: [a.main],
      }),
    );
    expect(restricted.totals[0]).toMatchObject({ count: 1, net: 100 });
    expect(restricted.unattributed).toEqual([]);
    expect(restricted.options.locations.map((l) => l.id)).toEqual([a.main]);
  });

  it('el detalle trae el paciente y la sede de la clínica en contexto', async () => {
    const page = await context.run(a.tenantId, () =>
      repo.listItems(
        OCTOBER,
        { locationIds: [a.main, a.other], catalogItemId: a.catalogItemId },
        { skip: 0, take: 1 },
      ),
    );
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      patientName: 'Paciente dx423-a',
      currency: 'COP',
      // La zona de la sede donde se realizó: la web fecha cada ítem con ella.
      timeZone: 'America/Bogota',
    });
  });

  it('profesionales: solo quien realizó algo en esas sedes, ex-miembros incluidos', async () => {
    const onlyMain = await context.run(a.tenantId, () =>
      repo.listProfessionals([a.main]),
    );
    expect(onlyMain.map((p) => p.userId)).toEqual([a.dentistId]);
    // Un ex-miembro (membresía retirada) con un realizado en la principal.
    const user = await raw.user.create({
      data: {
        email: `ex-${a.tenantId}@example.com`,
        passwordHash: 'x',
        fullName: 'Aaa Ex Miembro',
      },
    });
    const membership = await raw.clinicMembership.create({
      data: {
        tenantId: a.tenantId,
        userId: user.id,
        role: 'DENTIST',
        deletedAt: new Date(),
      },
    });
    await raw.treatmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        planId: (
          await raw.treatmentPlan.findFirstOrThrow({
            where: { tenantId: a.tenantId },
          })
        ).id,
        toothNumber: '11',
        catalogItemId: a.catalogItemId,
        price: 1,
        status: 'DONE',
        performedById: user.id,
        performedByMembershipId: membership.id,
        performedLocationId: a.main,
        completedAt: new Date('2026-09-05T15:00:00Z'),
      },
    });
    const withEx = await context.run(a.tenantId, () =>
      repo.listProfessionals([a.main]),
    );
    expect(withEx.map((p) => p.fullName)).toEqual([
      'Aaa Ex Miembro',
      'Dra. Reportes',
    ]);
    // Nada de otra clínica, aunque se pidan sus sedes.
    const crossed = await context.run(a.tenantId, () =>
      repo.listProfessionals([b.main, b.other]),
    );
    expect(crossed).toEqual([]);
  });

  it('categorías recortadas: el filtro y la lista ignoran los blancos de los extremos', async () => {
    const spaced = await raw.dentalCatalogItem.create({
      data: {
        tenantId: a.tenantId,
        code: 'ENDO-SP',
        kind: 'PROCEDURE',
        labelEs: 'Endodoncia',
        category: '  Endodoncia ',
        color: '#123456',
      },
    });
    const plan = await raw.treatmentPlan.findFirstOrThrow({
      where: { tenantId: a.tenantId },
    });
    const dentist = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId: a.tenantId, userId: a.dentistId },
    });
    await raw.treatmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        planId: plan.id,
        toothNumber: '36',
        catalogItemId: spaced.id,
        price: 300,
        status: 'DONE',
        performedById: a.dentistId,
        performedByMembershipId: dentist.id,
        performedLocationId: a.main,
        completedAt: new Date('2026-10-06T15:00:00Z'),
      },
    });
    const categories = await context.run(a.tenantId, () =>
      repo.listCategories(),
    );
    expect(categories).toEqual(['Endodoncia', 'Operatoria']);
    const sums = await context.run(a.tenantId, () =>
      repo.aggregate(OCTOBER, {
        locationIds: [a.main],
        category: 'Endodoncia',
      }),
    );
    expect(sums).toEqual([
      expect.objectContaining({ category: 'Endodoncia', gross: 300 }),
    ]);
  });

  it('paciente eliminado: el detalle no lo nombra (paciente null)', async () => {
    const patient = await raw.patient.create({
      data: {
        tenantId: a.tenantId,
        firstName: 'Borrado',
        lastName: 'Eliminado',
        deletedAt: new Date(),
      },
    });
    const plan = await raw.treatmentPlan.create({
      data: {
        tenantId: a.tenantId,
        patientId: patient.id,
        currency: 'USD',
        status: 'ACCEPTED',
      },
    });
    const dentist = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId: a.tenantId, userId: a.dentistId },
    });
    await raw.treatmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        planId: plan.id,
        toothNumber: '21',
        catalogItemId: a.catalogItemId,
        price: 40,
        status: 'DONE',
        performedById: a.dentistId,
        performedByMembershipId: dentist.id,
        performedLocationId: a.main,
        completedAt: new Date('2026-10-07T15:00:00Z'),
      },
    });
    const page = await context.run(a.tenantId, () =>
      repo.listItems(
        OCTOBER,
        {
          locationIds: [a.main],
          catalogItemId: a.catalogItemId,
          currency: 'USD',
        },
        { skip: 0, take: 10 },
      ),
    );
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      patientId: null,
      patientName: null,
      price: 40,
    });
    expect(JSON.stringify(page.items)).not.toContain('Borrado');
  });
});
