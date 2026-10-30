import { Prisma, PrismaClient } from '@prisma/client';
import {
  type ListQueryArgs,
  countQuery,
  pageQuery,
} from '../src/modules/expenses/infrastructure/repositories/expense-list-query';
import type { ExpenseListFilters } from '../src/modules/expenses/domain/ports/expense-repository.port';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-393 (auditoría DB-059): la lista de gastos con 20.000 gastos en 5 sedes,
// 1 pago cada uno (la vista por defecto de un ADMIN de una clínica grande).
// EXPLAIN ANALYZE de la consulta REAL del repositorio (`pageQuery` y
// `countQuery`) como dentalix_app con la clínica fijada: la página sale del
// índice nuevo, solo suma los pagos de sus filas y tarda < 15 ms. `raw`
// (DIRECT_URL, owner) siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAIN = 'dx393-plan';
const EMAIL = 'dx393-plan@example.com';
const VOLUME = 20_000;
const LOCATIONS = 5;
const PAGE_SIZE = 25;
const BUDGET_MS = 15;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Loops'?: number;
  'Actual Rows'?: number;
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
let locationIds: string[];

async function explain(sql: Prisma.Sql): Promise<Explained> {
  const rows = await prisma.runWithTenant(tenantId, (tx) =>
    tx.$queryRaw<
      { 'QUERY PLAN': { Plan: PlanNode; 'Execution Time': number }[] }[]
    >(Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`),
  );
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

function args(filters: Partial<ExpenseListFilters> = {}): ListQueryArgs {
  return {
    tenantId,
    filters: { page: 1, pageSize: PAGE_SIZE, ...filters },
    scope: undefined,
    todays: {
      ids: locationIds,
      days: locationIds.map(() => '2026-10-30'),
    },
  };
}

const indexesOn = (plan: Explained, table: string) =>
  plan.nodes
    .filter((n) => n['Relation Name'] === table)
    .map((n) => n['Index Name'] ?? n['Node Type']);

/** Veces que se suma lo pagado: una por gasto que la consulta mira. */
const paymentLoops = (plan: Explained) =>
  plan.nodes
    .filter((n) => n['Relation Name'] === 'expense_payments')
    .reduce((sum, n) => sum + (n['Actual Loops'] ?? 0), 0);

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length > 0) {
    const where = { tenantId: { in: ids } };
    await raw.expensePayment.deleteMany({ where });
    await raw.expense.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  await raw.user.deleteMany({ where: { email: EMAIL } });
}

describe('DX-393 · lista de gastos con 20.000 gastos (int, rendimiento)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    const tenant = await raw.tenant.create({
      data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
    });
    tenantId = tenant.id;
    locationIds = [];
    for (let i = 0; i < LOCATIONS; i += 1) {
      const location = await raw.location.create({
        data: locationData(REGIONAL_BOGOTA_FIXTURE, {
          tenantId,
          name: `Sede ${i + 1}`,
          country: 'CO',
        }),
      });
      locationIds.push(location.id);
    }
    const user = await raw.user.create({
      data: { email: EMAIL, passwordHash: 'x', fullName: 'Ada Admin' },
    });
    // Dos años de facturas, repartidas por sede; un pago de 50 por gasto.
    await raw.$executeRaw`
      INSERT INTO "expenses"
        ("id", "tenantId", "locationId", "category", "amount", "currency",
         "invoiceDate", "createdById", "updatedAt")
      SELECT gen_random_uuid(), ${tenantId}::uuid,
             (${locationIds}::uuid[])[1 + g % ${LOCATIONS}::int],
             'Insumos clínicos', 100, 'COP',
             date '2024-11-01' + (g % 730), ${user.id}::uuid, now()
        FROM generate_series(1, ${VOLUME}::int) AS g`;
    await raw.$executeRaw`
      INSERT INTO "expense_payments"
        ("id", "tenantId", "expenseId", "locationId", "amount", "currency",
         "method", "paidOn", "createdById")
      SELECT gen_random_uuid(), e."tenantId", e."id", e."locationId", 50,
             e."currency", 'TRANSFER', e."invoiceDate", e."createdById"
        FROM "expenses" e WHERE e."tenantId" = ${tenantId}::uuid`;
    await raw.$executeRawUnsafe('ANALYZE "expenses"');
    await raw.$executeRawUnsafe('ANALYZE "expense_payments"');
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  it('página 1 sin filtros: índice nuevo, 25 sumas de pagos y < 15 ms', async () => {
    const plan = await bestOf(pageQuery(args()));
    expect(indexesOn(plan, 'expenses')).toEqual([
      'expenses_tenant_invoice_created_idx',
    ]);
    // Solo se ordena la página ya cortada (25 filas), no la clínica entera.
    const sorts = plan.nodes.filter((n) => n['Node Type'] === 'Sort');
    expect(sorts.every((n) => (n['Actual Rows'] ?? 0) <= PAGE_SIZE)).toBe(true);
    expect(paymentLoops(plan)).toBe(PAGE_SIZE);
    expect(plan.executionMs).toBeLessThan(BUDGET_MS);
  });

  it('una página más adentro solo suma los pagos de su página', async () => {
    const plan = await bestOf(pageQuery(args({ page: 40 })));
    expect(indexesOn(plan, 'expenses')).toEqual([
      'expenses_tenant_invoice_created_idx',
    ]);
    expect(paymentLoops(plan)).toBe(PAGE_SIZE);
    expect(plan.executionMs).toBeLessThan(BUDGET_MS);
  });

  it('con sede: el índice por sede, 25 sumas y < 15 ms', async () => {
    const plan = await bestOf(pageQuery(args({ locationId: locationIds[2] })));
    expect(indexesOn(plan, 'expenses')).toEqual([
      'expenses_tenant_location_invoice_created_idx',
    ]);
    expect(paymentLoops(plan)).toBe(PAGE_SIZE);
    expect(plan.executionMs).toBeLessThan(BUDGET_MS);
  });

  it('el total sin filtro de estado no suma ningún pago', async () => {
    const plan = await bestOf(countQuery(args()));
    expect(paymentLoops(plan)).toBe(0);
    expect(plan.executionMs).toBeLessThan(BUDGET_MS);
  });

  it('la página y el total devuelven lo mismo que antes: orden y pagado', async () => {
    const rows = await prisma.runWithTenant(tenantId, (tx) =>
      tx.$queryRaw<
        { invoiceDate: Date; createdAt: Date; id: string; paidCents: bigint }[]
      >(pageQuery(args({ page: 2 }))),
    );
    expect(rows).toHaveLength(PAGE_SIZE);
    expect(rows.every((r) => r.paidCents === 5_000n)).toBe(true);
    const expected = await raw.expense.findMany({
      where: { tenantId },
      orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true },
    });
    expect(rows.map((r) => r.id)).toEqual(expected.map((r) => r.id));
    const [count] = await prisma.runWithTenant(tenantId, (tx) =>
      tx.$queryRaw<{ total: number }[]>(countQuery(args())),
    );
    expect(count.total).toBe(VOLUME);
  });
});
