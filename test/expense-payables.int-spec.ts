import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaExpensePayablesRepository } from '../src/modules/expenses/infrastructure/repositories/prisma-expense-payables.repository';
import type { PayableSupplierRow } from '../src/modules/expenses/domain/ports/expense-payables-repository.port';
import { resetDatabase } from './support/e2e-fixtures';
import { ReportSeeder } from './support/reports-fixtures';

// DX-411 · cuentas por pagar por proveedor contra Postgres de verdad, como
// dentalix_app (DATABASE_URL, sin BYPASSRLS) con la clínica fijada por
// runWithTenant. `raw` (DIRECT_URL, owner) solo siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

/**
 * Reloj fijo: 12:00 del 10/11/2026 en Caracas (UTC−4) y ya 01:00 del 11/11
 * en Tokio (UTC+9). Así el mismo vencimiento (10/11) es «hoy» en una sede y
 * «vencido» en la otra.
 */
const NOW = new Date('2026-11-10T16:00:00Z');
const LAB = 'laboratorio dental avila';

const SOURCE_TABLES = ['locations', 'expenses', 'expense_payments'];

interface SeededClinic {
  tenantId: string;
  principal: string;
  tokio: string;
  ids: Record<string, string>;
  seed: ReportSeeder;
}

/**
 * Clínica A, sede principal (Caracas, hoy = 10/11):
 *  E1 «  Laboratorio  Dental Ávila » 120 USD, vence 09/11 (vencido), pagos 20
 *     vivo + 50 anulado → pendiente 100.
 *  E2 «LABORATORIO DENTAL AVILA» 80 USD, vence 10/11 (hoy: 7 y 30 días).
 *  E3 «Laboratorio Dental Ávila» 50 USD, vence 16/11 (hoy + 6: 7 y 30 días).
 *  E4 30 USD, vence 17/11 (hoy + 7: solo 30 días).
 *  E5 10 USD, vence 09/12 (hoy + 29: 30 días).
 *  E6 5 USD, vence 10/12 (hoy + 30: ningún tramo).
 *  E7 40 USD, sin vencimiento.
 *  E8 1.000 VES, vence 20/11 (otra moneda: otra fila).
 *  E9 999 USD anulado; E10 60 USD pagado del todo: fuera.
 *  E11 sin proveedor, 25 USD, vence 01/11 (vencido).
 *  E12 «Depósito Dental Caracas» 70 USD, pagos 40 vivo + 30 anulado, sin
 *      vencimiento → pendiente 30.
 * Sede Tokio (hoy = 11/11):
 *  E13 «laboratorio dental ávila» 15 USD, vence 10/11 → vencido allí; es el
 *      gasto abierto más reciente del grupo (su grafía es la que se muestra).
 */
async function seedClinic(subdomain: string): Promise<SeededClinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const seed = new ReportSeeder(raw, tenant.id);
  const principal = await seed.location('Sede principal');
  const tokio = await seed.location('Sede Tokio');
  await raw.location.update({
    where: { id: tokio },
    data: { timeZone: 'Asia/Tokyo' },
  });
  const ids: Record<string, string> = {};
  const usd = (
    name: string,
    amount: number,
    patch: Partial<Parameters<ReportSeeder['expense']>[0]> = {},
  ) =>
    seed
      .expense({
        locationId: principal,
        currency: 'USD',
        amount,
        category: 'Laboratorio',
        supplier: 'Laboratorio Dental Ávila',
        invoiceDate: '2026-11-01',
        ...patch,
      })
      .then((id) => (ids[name] = id));
  await usd('E1', 120, {
    supplier: '  Laboratorio  Dental Ávila ',
    dueDate: '2026-11-09',
    payments: [
      { amount: 20, paidOn: '2026-11-02' },
      { amount: 50, paidOn: '2026-11-02', voided: true },
    ],
  });
  await usd('E2', 80, {
    supplier: 'LABORATORIO DENTAL AVILA',
    invoiceDate: '2026-11-03',
    dueDate: '2026-11-10',
  });
  await usd('E3', 50, { dueDate: '2026-11-16' });
  await usd('E4', 30, { dueDate: '2026-11-17' });
  await usd('E5', 10, { dueDate: '2026-12-09' });
  await usd('E6', 5, { dueDate: '2026-12-10' });
  await usd('E7', 40);
  await usd('E8', 1000, { currency: 'VES', dueDate: '2026-11-20' });
  await usd('E9', 999, { dueDate: '2026-11-01', voided: true });
  await usd('E10', 60, {
    dueDate: '2026-11-01',
    payments: [{ amount: 60, paidOn: '2026-11-02' }],
  });
  await usd('E11', 25, {
    supplier: undefined,
    category: 'Mensajería',
    dueDate: '2026-11-01',
  });
  await usd('E12', 70, {
    supplier: 'Depósito Dental Caracas',
    category: 'Insumos clínicos',
    payments: [
      { amount: 40, paidOn: '2026-11-02' },
      { amount: 30, paidOn: '2026-11-02', voided: true },
    ],
  });
  await usd('E13', 15, {
    locationId: tokio,
    supplier: 'laboratorio dental ávila',
    invoiceDate: '2026-11-02',
    dueDate: '2026-11-10',
  });
  return { tenantId: tenant.id, principal, tokio, ids, seed };
}

const amounts = {
  openCount: 0,
  pendingCents: 0,
  overdueCount: 0,
  overdueCents: 0,
  dueIn7DaysCount: 0,
  dueIn7DaysCents: 0,
  dueIn30DaysCount: 0,
  dueIn30DaysCents: 0,
  noDueDateCount: 0,
  noDueDateCents: 0,
};

const byKey = (rows: PayableSupplierRow[]) =>
  [...rows].sort((a, b) =>
    `${a.supplierKey}|${a.currency}`.localeCompare(
      `${b.supplierKey}|${b.currency}`,
    ),
  );

describe('Cuentas por pagar por proveedor en la BD (DX-411, int)', () => {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const repo = new PrismaExpensePayablesRepository(prisma, context);
  let a: SeededClinic;
  let b: SeededClinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(raw);
    a = await seedClinic('dx411-a');
    b = await seedClinic('dx411-b');
    // Un gasto abierto más en B, para que sus totales difieran de los de A.
    await b.seed.expense({
      locationId: b.principal,
      currency: 'USD',
      amount: 777,
      category: 'Laboratorio',
      supplier: 'Laboratorio Dental Ávila',
      invoiceDate: '2026-11-01',
    });
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
         AND relname = ANY(${SOURCE_TABLES})`;
    expect(rows.map((r) => r.relname).sort()).toEqual(
      [...SOURCE_TABLES].sort(),
    );
    expect(rows.filter((r) => !r.enabled || !r.forced)).toEqual([]);
  });

  it('agrupa por proveedor normalizado y moneda, con los tramos en el día de la sede de cada gasto', async () => {
    const rows = await context.run(a.tenantId, () => repo.payables({}, NOW));
    expect(byKey(rows)).toEqual(
      byKey([
        {
          ...amounts,
          supplierKey: '',
          supplier: null,
          currency: 'USD',
          openCount: 1,
          pendingCents: 2_500,
          overdueCount: 1,
          overdueCents: 2_500,
          oldestDueDate: '2026-11-01',
        },
        {
          ...amounts,
          supplierKey: 'deposito dental caracas',
          supplier: 'Depósito Dental Caracas',
          currency: 'USD',
          openCount: 1,
          pendingCents: 3_000,
          noDueDateCount: 1,
          noDueDateCents: 3_000,
          oldestDueDate: null,
        },
        {
          // E1 100 + E13 15 vencidos; E2 80 + E3 50 en 7 días; E2 + E3 +
          // E4 30 + E5 10 en 30 días; E6 5 en ningún tramo; E7 40 sin
          // vencimiento. Pendiente 100+80+50+30+10+5+40+15 = 330.
          supplierKey: LAB,
          supplier: 'laboratorio dental ávila',
          currency: 'USD',
          openCount: 8,
          pendingCents: 33_000,
          overdueCount: 2,
          overdueCents: 11_500,
          dueIn7DaysCount: 2,
          dueIn7DaysCents: 13_000,
          dueIn30DaysCount: 4,
          dueIn30DaysCents: 17_000,
          noDueDateCount: 1,
          noDueDateCents: 4_000,
          oldestDueDate: '2026-11-09',
        },
        {
          ...amounts,
          supplierKey: LAB,
          supplier: 'Laboratorio Dental Ávila',
          currency: 'VES',
          openCount: 1,
          pendingCents: 100_000,
          dueIn30DaysCount: 1,
          dueIn30DaysCents: 100_000,
          oldestDueDate: '2026-11-20',
        },
      ]),
    );
  });

  it('el mismo vencimiento es «hoy» en Caracas y vencido en Tokio', async () => {
    const [caracas] = await context.run(a.tenantId, () =>
      repo
        .payables({ locationId: a.principal, currency: 'USD' }, NOW)
        .then((rows) => rows.filter((r) => r.supplierKey === LAB)),
    );
    // Sin E13 (Tokio): E1 vencido; E2 (vence hoy) en 7 días.
    expect(caracas).toMatchObject({
      supplier: 'Laboratorio Dental Ávila',
      openCount: 7,
      pendingCents: 31_500,
      overdueCount: 1,
      overdueCents: 10_000,
      dueIn7DaysCount: 2,
      dueIn7DaysCents: 13_000,
    });
    const tokio = await context.run(a.tenantId, () =>
      repo.payables({ locationId: a.tokio }, NOW),
    );
    expect(tokio).toEqual([
      {
        ...amounts,
        supplierKey: LAB,
        supplier: 'laboratorio dental ávila',
        currency: 'USD',
        openCount: 1,
        pendingCents: 1_500,
        overdueCount: 1,
        overdueCents: 1_500,
        oldestDueDate: '2026-11-10',
      },
    ]);
  });

  it('filtra por moneda', async () => {
    const rows = await context.run(a.tenantId, () =>
      repo.payables({ currency: 'VES' }, NOW),
    );
    expect(rows.map((r) => [r.supplierKey, r.currency])).toEqual([
      [LAB, 'VES'],
    ]);
  });

  it('aislamiento: cada clínica ve solo lo suyo (RLS y tenantId)', async () => {
    const rows = await context.run(b.tenantId, () =>
      repo.payables({ currency: 'USD' }, NOW),
    );
    const lab = rows.find((r) => r.supplierKey === LAB);
    expect(lab?.openCount).toBe(9);
    expect(lab?.pendingCents).toBe(33_000 + 77_700);
    // Una sede de A pedida desde B no devuelve nada.
    const foreign = await context.run(b.tenantId, () =>
      repo.payables({ locationId: a.principal }, NOW),
    );
    expect(foreign).toEqual([]);
  });

  it('sedes permitidas: un miembro acotado a Tokio no ve la principal, ni pidiéndola', async () => {
    const scoped = (locationId?: string) =>
      context.run(
        a.tenantId,
        undefined,
        () => repo.payables({ locationId }, NOW),
        [a.tokio],
      );
    expect((await scoped()).map((r) => r.openCount)).toEqual([1]);
    expect(await scoped(a.principal)).toEqual([]);
    const items = await context.run(
      a.tenantId,
      undefined,
      () =>
        repo.payableExpenses(
          {
            supplierKey: LAB,
            currency: 'USD',
            locationId: a.principal,
            limit: 500,
          },
          NOW,
        ),
      [a.tokio],
    );
    expect(items).toEqual({ items: [], total: 0 });
  });

  it('detalle: los abiertos del grupo por vencimiento (sin vencimiento al final), con la clave en cualquier grafía', async () => {
    const found = await context.run(a.tenantId, () =>
      repo.payableExpenses(
        {
          supplierKey: 'LABORATORIO  DENTAL ÁVILA ',
          currency: 'USD',
          limit: 500,
        },
        NOW,
      ),
    );
    expect(found.total).toBe(8);
    expect(
      found.items.map((e) => [e.id, e.amount - e.paidAmount, e.overdue]),
    ).toEqual([
      [a.ids.E1, 100, true],
      // Mismo vencimiento: primero la factura más antigua (E13, del 02/11).
      [a.ids.E13, 15, true],
      [a.ids.E2, 80, false],
      [a.ids.E3, 50, false],
      [a.ids.E4, 30, false],
      [a.ids.E5, 10, false],
      [a.ids.E6, 5, false],
      [a.ids.E7, 40, false],
    ]);
    const capped = await context.run(a.tenantId, () =>
      repo.payableExpenses(
        { supplierKey: LAB, currency: 'USD', limit: 3 },
        NOW,
      ),
    );
    expect(capped.items).toHaveLength(3);
    expect(capped.total).toBe(8);
  });

  it('detalle «Sin proveedor» con la clave vacía; de otra clínica, nada', async () => {
    const none = await context.run(a.tenantId, () =>
      repo.payableExpenses(
        { supplierKey: '', currency: 'USD', limit: 500 },
        NOW,
      ),
    );
    expect(none.items.map((e) => e.id)).toEqual([a.ids.E11]);
    const fromB = await context.run(b.tenantId, () =>
      repo.payableExpenses(
        {
          supplierKey: '',
          currency: 'USD',
          locationId: a.principal,
          limit: 500,
        },
        NOW,
      ),
    );
    expect(fromB).toEqual({ items: [], total: 0 });
  });
});
