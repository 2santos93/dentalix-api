import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-149 (auditoría DB-030): el panel de «Pendientes por agendar» de una clínica
// con 60.000 pacientes y 40.000 entradas, 400 de ellas abiertas en la sede.
// EXPLAIN ANALYZE como dentalix_app (runWithTenant, RLS) de la página y del
// total tal como los pide el repositorio: estado y sede como PARÁMETROS, y con
// `plan_cache_mode = force_generic_plan`, que es el plan que Postgres acaba
// usando en una sentencia preparada repetida. `raw` (DIRECT_URL, owner)
// siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAIN = 'dx149-panel';
const PATIENTS = 60_000;
const ENTRIES = 40_000;
const OPEN = 400;
const PAGE_SIZE = 20;
const BUDGET_MS = 2;
const PANEL_INDEX = 'appointment_waitlist_panel_idx';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

interface Explained {
  nodes: PlanNode[];
  executionMs: number;
}

function flatten(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(flatten)];
}

let tenantId: string;
let locationId: string;

async function explain(sql: Prisma.Sql): Promise<Explained> {
  const rows = await prisma.runWithTenant(tenantId, async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL plan_cache_mode = force_generic_plan`,
    );
    return tx.$queryRaw<
      { 'QUERY PLAN': { Plan: PlanNode; 'Execution Time': number }[] }[]
    >(Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);
  });
  const [result] = rows[0]['QUERY PLAN'];
  return { nodes: flatten(result.Plan), executionMs: result['Execution Time'] };
}

/** El mejor de 5 (el primero calienta la caché): lo que cuesta la consulta. */
async function bestOf(sql: Prisma.Sql): Promise<Explained> {
  let best: Explained | undefined;
  for (let i = 0; i < 5; i += 1) {
    const run = await explain(sql);
    if (!best || run.executionMs < best.executionMs) best = run;
  }
  return best!;
}

const relations = (plan: Explained) =>
  plan.nodes.map((n) => n['Relation Name']).filter(Boolean);
const indexes = (plan: Explained) =>
  plan.nodes.map((n) => n['Index Name']).filter(Boolean);

// La consulta del repositorio con el estado OPEN: sin unir con `patients`.
const where = () =>
  Prisma.sql`"status" = ${'OPEN'}::"WaitlistStatus" AND "locationId" = ${locationId}::uuid`;

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const scoped = { tenantId: { in: ids } };
  await raw.appointmentWaitlistEntry.deleteMany({ where: scoped });
  await raw.patient.deleteMany({ where: scoped });
  await raw.location.deleteMany({ where: scoped });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
}

describe('DX-149 · panel de pendientes con 60.000 pacientes (int, rendimiento)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    const tenant = await raw.tenant.create({
      data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
    });
    tenantId = tenant.id;
    const location = await raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId,
        name: 'Sede Chacao',
        country: 'VE',
      }),
    });
    locationId = location.id;
    await raw.$executeRaw`
      INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName", "updatedAt")
      SELECT gen_random_uuid(), ${tenantId}::uuid, 'Paciente', 'DX149 ' || g, now()
        FROM generate_series(1, ${PATIENTS}::int) AS g`;
    // 40.000 entradas de los primeros pacientes: las 400 más recientes siguen
    // abiertas (una por paciente, DX-161); el resto se descartaron.
    await raw.$executeRaw`
      INSERT INTO "appointment_waitlist"
        ("id", "tenantId", "locationId", "patientId", "priority", "status",
         "dismissReason", "resolvedAt", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), ${tenantId}::uuid, ${locationId}::uuid, p."id",
             (CASE WHEN p.n % 10 = 0 THEN 'URGENT' ELSE 'NORMAL' END)::"WaitlistPriority",
             (CASE WHEN p.n > ${ENTRIES - OPEN}::int THEN 'OPEN' ELSE 'DISMISSED' END)::"WaitlistStatus",
             CASE WHEN p.n > ${ENTRIES - OPEN}::int THEN NULL ELSE 'Ya agendó por teléfono' END,
             CASE WHEN p.n > ${ENTRIES - OPEN}::int THEN NULL ELSE now() END,
             now() - make_interval(mins => p.n::int), now()
        FROM (
          SELECT "id", row_number() OVER (ORDER BY "id") AS n
            FROM "patients" WHERE "tenantId" = ${tenantId}::uuid
        ) p
       WHERE p.n <= ${ENTRIES}::int`;
    await raw.$executeRawUnsafe('ANALYZE "patients"');
    await raw.$executeRawUnsafe('ANALYZE "appointment_waitlist"');
  }, 180_000);

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  it(`la página sale del índice del panel, sin pacientes, en < ${BUDGET_MS} ms`, async () => {
    const plan = await bestOf(Prisma.sql`
      SELECT "id" FROM "appointment_waitlist"
       WHERE ${where()}
       ORDER BY "priority" DESC, "createdAt" ASC, "id" ASC
       LIMIT ${PAGE_SIZE}::int OFFSET 0`);
    expect(indexes(plan)).toContain(PANEL_INDEX);
    expect(relations(plan)).not.toContain('patients');
    expect(plan.nodes.map((n) => n['Node Type'])).not.toContain('Sort');
    expect(plan.executionMs).toBeLessThan(BUDGET_MS);
  });

  it('el total cuenta sobre el índice, sin recorrer los pacientes de la clínica', async () => {
    const plan = await bestOf(
      Prisma.sql`SELECT count(*) FROM "appointment_waitlist" WHERE ${where()}`,
    );
    expect(indexes(plan)).toContain(PANEL_INDEX);
    expect(relations(plan)).not.toContain('patients');
    expect(plan.executionMs).toBeLessThan(BUDGET_MS);
  });

  it('el total es el de las abiertas', async () => {
    const [{ total }] = await prisma.runWithTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<{ total: bigint }[]>`
        SELECT count(*) AS total FROM "appointment_waitlist" WHERE ${where()}`,
    );
    expect(Number(total)).toBe(OPEN);
  });
});
