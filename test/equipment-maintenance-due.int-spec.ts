import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { ListMaintenanceDueUseCase } from '../src/modules/equipment/application/use-cases/list-maintenance-due.use-case';
import {
  PrismaEquipmentRepository,
  maintenanceCandidatesSql,
} from '../src/modules/equipment/infrastructure/repositories/prisma-equipment.repository';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-543, capa BD: los avisos de mantenimiento de «Mi día» con el repositorio
// Prisma REAL como `dentalix_app` (DATABASE_URL, RLS FORCE). `raw` (owner,
// DIRECT_URL) solo siembra y limpia. Prueba que la consulta SQL repite la
// regla del próximo de DX-542, que nunca sale otra clínica (ni por la RLS ni
// por el filtro de clínica), que sigue la sede activa y las permitidas, y que
// usa el índice parcial de los equipos activos.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repository = new PrismaEquipmentRepository(prisma, tenantContext);
/** 12:00 en Caracas del 6 de noviembre de 2026. */
const NOW = new Date('2026-11-06T16:00:00.000Z');
const useCase = new ListMaintenanceDueUseCase(
  repository,
  tenantContext,
  () => NOW,
);

const SUBDOMAINS = ['dx543-int-a', 'dx543-int-b'];
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);
const RETIRED_VOLUME = 3_000;

interface Clinic {
  tenantId: string;
  norte: string;
  sur: string;
  chairNorte: string;
  userId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = (name: string) =>
    raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId: tenant.id,
        name,
      }),
    });
  const norte = await location('Sede Norte');
  const sur = await location('Sede Sur');
  const chairNorte = await raw.chair.create({
    data: { tenantId: tenant.id, locationId: norte.id, name: 'Sillón 1' },
  });
  const user = await raw.user.create({
    data: {
      email: `admin@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Admin',
    },
  });
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'ADMIN' },
  });
  return {
    tenantId: tenant.id,
    norte: norte.id,
    sur: sur.id,
    chairNorte: chairNorte.id,
    userId: user.id,
  };
}

async function equipment(
  clinic: Clinic,
  name: string,
  data: Partial<Prisma.EquipmentUncheckedCreateInput> = {},
): Promise<string> {
  const row = await raw.equipment.create({
    data: {
      tenantId: clinic.tenantId,
      locationId: clinic.norte,
      name,
      category: 'OTHER',
      ...data,
    },
  });
  return row.id;
}

async function maintenance(
  clinic: Clinic,
  equipmentId: string,
  data: Partial<Prisma.EquipmentMaintenanceUncheckedCreateInput>,
): Promise<void> {
  await raw.equipmentMaintenance.create({
    data: {
      tenantId: clinic.tenantId,
      equipmentId,
      kind: 'PREVENTIVE',
      performedOn: DAY('2026-01-01'),
      description: 'Revisión',
      createdById: clinic.userId,
      ...data,
    },
  });
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  // Owner superusuario: el trigger deja borrar la hoja de vida en los tests.
  await raw.equipmentMaintenance.deleteMany({ where });
  await raw.equipment.deleteMany({ where });
  await raw.chair.deleteMany({ where });
  await raw.clinicMembership.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
  await raw.user.deleteMany({
    where: { email: { in: SUBDOMAINS.map((s) => `admin@${s}.test`) } },
  });
}

/** Como el interceptor: clínica, sede activa y sedes permitidas del token. */
function asRequest<T>(
  clinic: Clinic,
  fn: () => Promise<T>,
  scope: { locationId?: string; allowed?: readonly string[] } = {},
): Promise<T> {
  return tenantContext.run(
    clinic.tenantId,
    scope.locationId,
    fn,
    scope.allowed,
  );
}

const names = (out: { items: { name: string }[] }) =>
  out.items.map((i) => i.name);

interface PlanNode {
  'Index Name'?: string;
  'Relation Name'?: string;
  'Node Type': string;
  Plans?: PlanNode[];
}
const nodes = (plan: PlanNode): PlanNode[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(nodes),
];

describe('avisos de mantenimiento de «Mi día» en la BD (int, DX-543)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);

    // A · Norte: VENCIDO por su último preventivo vivo (fijó el 01/10).
    const unidad = await equipment(a, 'Unidad dental', {
      chairId: a.chairNorte,
      maintenanceIntervalMonths: 6,
      acquiredOn: DAY('2024-01-01'),
    });
    await maintenance(a, unidad, {
      performedOn: DAY('2026-04-01'),
      nextDueOn: DAY('2026-10-01'),
    });
    // Un preventivo posterior ANULADO no cuenta: sigue vencido.
    await maintenance(a, unidad, {
      performedOn: DAY('2026-10-20'),
      nextDueOn: DAY('2027-04-20'),
      voidedAt: new Date('2026-10-21T12:00:00.000Z'),
      voidedById: a.userId,
      voidReason: 'Registrado por error',
    });
    // A · Norte: vence pronto por adquisición + periodicidad, recortado a fin
    // de mes en SQL igual que en el dominio (31/05 + 6 meses = 30/11).
    await equipment(a, 'Compresor', {
      acquiredOn: DAY('2026-05-31'),
      maintenanceIntervalMonths: 6,
    });
    // A · Sur: vence pronto por la fecha del último preventivo + periodicidad
    // (sin próximo fijado): 16/11/2025 + 12 = 16/11/2026.
    const rx = await equipment(a, 'Rayos X', {
      locationId: a.sur,
      maintenanceIntervalMonths: 12,
    });
    await maintenance(a, rx, { performedOn: DAY('2025-11-16') });
    // A · Norte: al día, sin programar, solo correctivos y de baja → fuera.
    await equipment(a, 'Autoclave al día', {
      acquiredOn: DAY('2026-10-01'),
      maintenanceIntervalMonths: 6,
    });
    await equipment(a, 'Lámpara sin programar');
    const correctivo = await equipment(a, 'Ultrasonido solo correctivo');
    await maintenance(a, correctivo, {
      kind: 'CORRECTIVE',
      performedOn: DAY('2026-01-01'),
    });
    // La baja: muchas (crecen con los años) para que el plan use el índice
    // parcial de los activos.
    await raw.equipment.createMany({
      data: Array.from({ length: RETIRED_VOLUME }, (_, i) => ({
        tenantId: a.tenantId,
        locationId: i % 2 === 0 ? a.norte : a.sur,
        name: `Equipo dado de baja ${i}`,
        category: 'OTHER' as const,
        acquiredOn: DAY('2020-01-01'),
        maintenanceIntervalMonths: 6,
        status: 'RETIRED' as const,
        retiredOn: DAY('2025-01-01'),
        retiredReason: 'Reemplazado',
        retiredById: a.userId,
      })),
    });

    // B: un vencido en su Norte, que A nunca debe ver.
    await equipment(b, 'Unidad de B', {
      locationId: b.norte,
      acquiredOn: DAY('2025-01-01'),
      maintenanceIntervalMonths: 6,
    });
    await raw.$executeRawUnsafe('ANALYZE "equipment"');
    await raw.$executeRawUnsafe('ANALYZE "equipment_maintenances"');
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([raw.$disconnect(), prisma.$disconnect()]);
  });

  it('vista consolidada de A: vencidos y por vencer de sus sedes, lo más urgente primero', async () => {
    const out = await asRequest(a, () => useCase.execute({}));
    expect(out.total).toBe(3);
    expect(
      out.items.map((i) => [
        i.name,
        i.locationName,
        i.chairName,
        i.nextMaintenanceOn,
        i.maintenanceStatus,
        i.daysUntilDue,
      ]),
    ).toEqual([
      ['Unidad dental', 'Sede Norte', 'Sillón 1', '2026-10-01', 'OVERDUE', -36],
      ['Rayos X', 'Sede Sur', null, '2026-11-16', 'DUE_SOON', 10],
      ['Compresor', 'Sede Norte', null, '2026-11-30', 'DUE_SOON', 24],
    ]);
  });

  it('nunca otra clínica: B solo ve lo suyo y A nada de B', async () => {
    const outB = await asRequest(b, () => useCase.execute({}));
    expect(names(outB)).toEqual(['Unidad de B']);
    const outA = await asRequest(a, () => useCase.execute({}));
    expect(names(outA)).not.toContain('Unidad de B');
  });

  it('la RLS sola ya lo impide: la consulta con el id de A desde la sesión de B no devuelve nada', async () => {
    const leaked = await prisma.runWithTenant(b.tenantId, (tx) =>
      tx.$queryRaw<{ id: string }[]>(
        maintenanceCandidatesSql(a.tenantId, { dueOnOrBefore: '2099-12-31' }),
      ),
    );
    expect(leaked).toEqual([]);
    // Ni con las sedes de A en el filtro.
    const bySede = await prisma.runWithTenant(b.tenantId, (tx) =>
      tx.$queryRaw<{ id: string }[]>(
        maintenanceCandidatesSql(a.tenantId, {
          locationIds: [a.norte, a.sur],
          dueOnOrBefore: '2099-12-31',
        }),
      ),
    );
    expect(bySede).toEqual([]);
  });

  it('una sede de B en la cabecera de A no cuela nada de B (el filtro de clínica manda)', async () => {
    const out = await asRequest(a, () => useCase.execute({}), {
      locationId: b.norte,
    });
    expect(out).toMatchObject({ items: [], total: 0 });
  });

  it('sigue la sede activa (selector global)', async () => {
    const sur = await asRequest(a, () => useCase.execute({}), {
      locationId: a.sur,
    });
    expect(names(sur)).toEqual(['Rayos X']);
    const norte = await asRequest(a, () => useCase.execute({}), {
      locationId: a.norte,
    });
    expect(names(norte)).toEqual(['Unidad dental', 'Compresor']);
  });

  it('un usuario restringido a una sede solo ve esa sede sin cabecera, y nada con `loc = []`', async () => {
    const onlySur = await asRequest(a, () => useCase.execute({}), {
      allowed: [a.sur],
    });
    expect(names(onlySur)).toEqual(['Rayos X']);
    const none = await asRequest(a, () => useCase.execute({}), {
      allowed: [],
    });
    expect(none).toMatchObject({ items: [], total: 0 });
  });

  it('el límite acota los items y el total los cuenta todos', async () => {
    const out = await asRequest(a, () => useCase.execute({ limit: 1 }));
    expect(names(out)).toEqual(['Unidad dental']);
    expect(out.total).toBe(3);
  });

  it('bajo RLS FORCE usa el índice parcial de los equipos activos', async () => {
    const rows = await prisma.runWithTenant(a.tenantId, (tx) =>
      tx.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
        Prisma.sql`EXPLAIN (FORMAT JSON) ${maintenanceCandidatesSql(
          a.tenantId,
          { locationIds: [a.norte], dueOnOrBefore: '2026-12-07' },
        )}`,
      ),
    );
    const plan = nodes(rows[0]['QUERY PLAN'][0].Plan);
    expect(plan.map((n) => n['Index Name'])).toContain(
      'equipment_tenant_active_location_idx',
    );
    expect(
      plan.some(
        (n) =>
          n['Relation Name'] === 'equipment' && n['Node Type'] === 'Seq Scan',
      ),
    ).toBe(false);
  });
});
