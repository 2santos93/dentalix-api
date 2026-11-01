import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaLocationsComparisonRepository } from '../src/modules/reports/infrastructure/prisma-locations-comparison.repository';
import type { ComparisonLocation } from '../src/modules/reports/domain/ports/locations-comparison-repository.port';
import { resetDatabase } from './support/e2e-fixtures';
import { ReportSeeder } from './support/reports-fixtures';

// DX-014 · las consultas de «Comparar sedes» contra Postgres de verdad, como
// dentalix_app (DATABASE_URL, sin BYPASSRLS) con la clínica fijada por
// runWithTenant. `raw` (DIRECT_URL, owner) solo siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };

/** Las tablas que lee el reporte: todas con RLS FORZADA por clínica. */
const SOURCE_TABLES = [
  'locations',
  'provider_schedules',
  'provider_schedule_ranges',
  'provider_schedule_overrides',
  'provider_schedule_override_ranges',
  'treatment_plans',
  'treatment_plan_items',
  'payments',
  'appointments',
  'schedule_blocks',
];

interface SeededClinic {
  tenantId: string;
  locations: ComparisonLocation[];
}

async function seedClinic(
  subdomain: string,
  amount: number,
): Promise<SeededClinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const seed = new ReportSeeder(raw, tenant.id);
  const locationId = await seed.location('Sede principal');
  // La profesional atiende allí de lunes a viernes de 9 a 13 (240 min),
  // En la zona de la sede: es la capacidad de la sede (BE-042).
  const { userId: providerId } = await seed.dentist();
  await seed.providerSchedule({
    providerId,
    locationId,
    ranges: [1, 2, 3, 4, 5].map((weekday) => ({
      weekday,
      startMinute: 540,
      endMinute: 780,
    })),
  });
  // Cierre de toda la sede el lunes 19/10 de 9 a 11 (120 min).
  await raw.scheduleBlock.create({
    data: {
      tenantId: tenant.id,
      locationId,
      start: new Date('2026-10-19T14:00:00Z'),
      end: new Date('2026-10-19T16:00:00Z'),
      kind: 'OTHER',
    },
  });
  // Uno que admite citas (almuerzo con aviso): no cierra la sede.
  await raw.scheduleBlock.create({
    data: {
      tenantId: tenant.id,
      locationId,
      start: new Date('2026-10-20T14:00:00Z'),
      end: new Date('2026-10-20T16:00:00Z'),
      kind: 'LUNCH',
      allowsBooking: true,
    },
  });
  const patientId = await seed.patient(subdomain);
  const planId = await seed.plan({
    patientId,
    currency: 'COP',
    price: amount,
    done: { locationId, at: new Date('2026-10-05T15:00:00Z') },
  });
  await seed.payment({
    planId,
    patientId,
    locationId,
    currency: 'COP',
    amount: amount / 2,
    paidAt: new Date('2026-10-06T15:00:00Z'),
  });
  await seed.appointments({
    locationId,
    patientIds: [patientId],
    firstDay: '2026-10-05',
    count: 3,
    status: 'COMPLETED',
  });
  return {
    tenantId: tenant.id,
    locations: [
      {
        id: locationId,
        name: 'Sede principal',
        isActive: true,
        timeZone: 'America/Bogota',
      },
    ],
  };
}

describe('Comparar sedes en la BD (DX-014, int)', () => {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const repo = new PrismaLocationsComparisonRepository(prisma, context);
  let a: SeededClinic;
  let b: SeededClinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(raw);
    a = await seedClinic('dx014-a', 100_000);
    b = await seedClinic('dx014-b', 7_000_000);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await raw.$disconnect();
  });

  it('las tablas que lee tienen RLS forzada', async () => {
    const rows = await raw.$queryRaw<
      { relname: string; enabled: boolean; forced: boolean }[]
    >`SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relname = ANY(${SOURCE_TABLES})
       ORDER BY relname`;
    expect(rows.map((r) => r.relname).sort()).toEqual(
      [...SOURCE_TABLES].sort(),
    );
    expect(rows.filter((r) => !r.enabled || !r.forced)).toEqual([]);
  });

  it('suma la actividad de la clínica en contexto', async () => {
    const result = await context.run(a.tenantId, () =>
      repo.aggregate(OCTOBER, a.locations),
    );
    const sums = result.byLocation.get(a.locations[0].id);
    expect(sums).toMatchObject({
      completed: 3,
      noShow: 0,
      attendedPatients: 1,
      newPatients: 1,
      completedMinutes: 90,
      // 22 días de lunes a viernes × 240 de su horario − 120 del cierre de
      // la sede del 19/10.
      capacityMinutes: 22 * 240 - 120,
    });
    expect([...(sums?.production ?? [])]).toEqual([['COP', 100_000]]);
    expect([...(sums?.collected ?? [])]).toEqual([['COP', 50_000]]);
    expect(result.attendedPatients).toBe(1);
  });

  it('las sedes son solo las de la clínica en contexto', async () => {
    const inA = await context.run(a.tenantId, () => repo.listLocations('ALL'));
    expect(inA.map((l) => l.id)).toEqual([a.locations[0].id]);
    expect(inA[0].timeZone).toBe('America/Bogota');
    const filtered = await context.run(a.tenantId, () =>
      repo.listLocations([b.locations[0].id]),
    );
    expect(filtered).toEqual([]);
  });

  it('con las sedes de otra clínica no devuelve nada de ella', async () => {
    const result = await context.run(a.tenantId, () =>
      repo.aggregate(OCTOBER, b.locations),
    );
    expect(result.attendedPatients).toBe(0);
    const sums = result.byLocation.get(b.locations[0].id);
    expect(sums).toMatchObject({ completed: 0, capacityMinutes: null });
    expect(sums?.production.size).toBe(0);
    expect(sums?.collected.size).toBe(0);
  });

  it('la RLS sola ya aísla: filtro explícito de B con la clínica A fijada → nada', async () => {
    // Las consultas filtran por el tenant de `asB` (B), pero la transacción
    // fija `app.current_tenant` = A: solo la RLS impide ver las filas de B.
    const asB = new TenantContextService();
    const crossed = new PrismaLocationsComparisonRepository(prisma, asB);
    const result = await context.run(a.tenantId, () =>
      asB.run(b.tenantId, () =>
        // `prisma` resuelve el tenant de `context` (A) para la RLS.
        crossed.aggregate(OCTOBER, b.locations),
      ),
    );
    expect(result.attendedPatients).toBe(0);
    const sums = result.byLocation.get(b.locations[0].id);
    expect(sums?.production.size).toBe(0);
    expect(sums?.collected.size).toBe(0);
    expect(sums?.completed).toBe(0);
    expect(sums?.capacityMinutes).toBeNull();
    // Control: con su propia clínica fijada, B sí ve lo suyo.
    const own = await context.run(b.tenantId, () =>
      repo.aggregate(OCTOBER, b.locations),
    );
    expect([
      ...(own.byLocation.get(b.locations[0].id)?.collected ?? []),
    ]).toEqual([['COP', 3_500_000]]);
  });

  it('producción atribuible: el instante lo fija la migración y los «Sin atribuir» son de la clínica en contexto', async () => {
    const [{ finishedAt }] = await raw.$queryRaw<{ finishedAt: Date }[]>`
      SELECT finished_at AS "finishedAt" FROM "_prisma_migrations"
       WHERE migration_name = '20261023160000_dx050_plan_item_attribution'`;
    const before = await context.run(a.tenantId, () =>
      repo.productionAttribution(),
    );
    expect(before).toEqual({
      attributedSince: finishedAt,
      hasUnattributed: false,
    });
    const seed = new ReportSeeder(raw, b.tenantId);
    await seed.unattributedDone({
      patientId: await seed.patient('Sin atribuir'),
      currency: 'COP',
      price: 1,
    });
    // El de B no cuenta para A (RLS y filtro explícito); para B, sí.
    await expect(
      context.run(a.tenantId, () => repo.productionAttribution()),
    ).resolves.toMatchObject({ hasUnattributed: false });
    await expect(
      context.run(b.tenantId, () => repo.productionAttribution()),
    ).resolves.toMatchObject({ hasUnattributed: true });
  });

  it('sin clínica en contexto no consulta', async () => {
    await expect(repo.aggregate(OCTOBER, a.locations)).rejects.toThrow(
      'No tenant in context',
    );
  });
});
