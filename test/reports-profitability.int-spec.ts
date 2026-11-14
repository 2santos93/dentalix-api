import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaProfitabilityRepository } from '../src/modules/reports/infrastructure/prisma-profitability.repository';
import type { ProfitabilityLocation } from '../src/modules/reports/domain/profitability';
import type { ProfitabilitySums } from '../src/modules/reports/domain/ports/profitability-repository.port';
import { resetDatabase } from './support/e2e-fixtures';
import { ReportSeeder } from './support/reports-fixtures';

// DX-410 · las consultas de «Rentabilidad por sede» contra Postgres de
// verdad, como dentalix_app (DATABASE_URL, sin BYPASSRLS) con la clínica
// fijada por runWithTenant. `raw` (DIRECT_URL, owner) solo siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };
const at = (iso: string) => new Date(iso);

/** Las tablas que lee el informe o su detalle: todas con RLS FORZADA. */
const SOURCE_TABLES = [
  'locations',
  'payments',
  'payment_receipts',
  'payment_methods',
  'treatment_plans',
  'treatment_plan_items',
  'dental_catalog_items',
  'expenses',
  'expense_payments',
];

interface SeededClinic {
  tenantId: string;
  principal: ProfitabilityLocation;
  norte: ProfitabilityLocation;
}

const loc = (id: string, name: string): ProfitabilityLocation => ({
  id,
  name,
  isActive: true,
  timeZone: 'America/Caracas',
});

/**
 * Octubre de 2026 en dos sedes (UTC−4), con `k` multiplicando los importes
 * para distinguir las clínicas:
 *  - principal: realizados 280 (300 − 20) y 100 USD (este, a las 23:00 del
 *    31/10 en la sede: 03:00 UTC del 1/11); abonos 200 y 50 USD (el segundo
 *    a las 23:30 del 31/10 en la sede), uno anulado y uno de las 23:00 del
 *    30/09 en la sede (01/10 en UTC: no es de octubre);
 *    gastos: Laboratorio 120 USD (factura 3/10; pagos 100 el 4/10 y 20 el
 *    2/11), Insumos 50 USD (factura 28/09, pagado el 1/10), Alquiler 10.000
 *    VES (factura 1/10, sin pagar), Papelería 30 USD (pago anulado) y uno
 *    anulado de 999 USD pagado en octubre;
 *  - Norte: Mensajería 40 USD facturada y pagada el 15/10.
 */
async function seedClinic(subdomain: string, k: number): Promise<SeededClinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const seed = new ReportSeeder(raw, tenant.id);
  const principal = await seed.location('Sede principal');
  const norte = await seed.location('Sede Norte');
  const patientId = await seed.patient(subdomain);
  await seed.plan({
    patientId,
    currency: 'USD',
    price: 300 * k,
    discount: 20 * k,
    done: { locationId: principal, at: at('2026-10-05T15:00:00Z') },
  });
  const planId = await seed.plan({
    patientId,
    currency: 'USD',
    price: 100 * k,
    done: { locationId: principal, at: at('2026-11-01T03:00:00Z') },
  });
  const pay = (amount: number, paidAt: string, voided = false) =>
    seed.payment({
      planId,
      patientId,
      locationId: principal,
      currency: 'USD',
      amount: amount * k,
      paidAt: at(paidAt),
      voided,
    });
  await pay(200, '2026-10-06T15:00:00Z');
  await pay(50, '2026-11-01T03:30:00Z');
  await pay(999, '2026-10-07T15:00:00Z', true);
  await pay(70, '2026-10-01T03:00:00Z');

  await seed.expense({
    locationId: principal,
    currency: 'USD',
    amount: 120 * k,
    category: 'Laboratorio',
    supplier: 'Laboratorio Dental Ávila',
    invoiceDate: '2026-10-03',
    payments: [
      { amount: 100 * k, paidOn: '2026-10-04' },
      { amount: 20 * k, paidOn: '2026-11-02' },
    ],
  });
  await seed.expense({
    locationId: principal,
    currency: 'USD',
    amount: 50 * k,
    category: 'Insumos clínicos',
    invoiceDate: '2026-09-28',
    payments: [{ amount: 50 * k, paidOn: '2026-10-01' }],
  });
  await seed.expense({
    locationId: principal,
    currency: 'VES',
    amount: 10_000 * k,
    category: 'Alquiler',
    invoiceDate: '2026-10-01',
  });
  await seed.expense({
    locationId: principal,
    currency: 'USD',
    amount: 30 * k,
    category: 'Papelería',
    invoiceDate: '2026-10-10',
    payments: [{ amount: 30 * k, paidOn: '2026-10-10', voided: true }],
  });
  await seed.expense({
    locationId: principal,
    currency: 'USD',
    amount: 999 * k,
    category: 'Otros',
    invoiceDate: '2026-10-12',
    payments: [{ amount: 999 * k, paidOn: '2026-10-12' }],
    voided: true,
  });
  await seed.expense({
    locationId: norte,
    currency: 'USD',
    amount: 40 * k,
    category: 'Mensajería',
    invoiceDate: '2026-10-15',
    payments: [{ amount: 40 * k, paidOn: '2026-10-15' }],
  });
  return {
    tenantId: tenant.id,
    principal: loc(principal, 'Sede principal'),
    norte: loc(norte, 'Sede Norte'),
  };
}

/** Las sumas como tuplas ordenadas, para compararlas sin depender del orden. */
function tuples(s: ProfitabilitySums) {
  const income = s.income
    .map((r) => [r.locationId, r.currency, r.cents, r.count])
    .sort();
  const expenses = s.expenses
    .map((r) => [r.locationId, r.currency, r.category, r.cents, r.count])
    .sort();
  return { income, expenses };
}

describe('Rentabilidad por sede en la BD (DX-410, int)', () => {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const repo = new PrismaProfitabilityRepository(prisma, context);
  let a: SeededClinic;
  let b: SeededClinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(raw);
    a = await seedClinic('dx410-a', 1);
    b = await seedClinic('dx410-b', 1000);
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

  it('Caja: abonos vivos − pagos de gastos vivos, por fecha de pago en el día de la sede', async () => {
    const sums = await context.run(a.tenantId, () =>
      repo.sums(OCTOBER, 'CASH', [a.principal, a.norte]),
    );
    expect(tuples(sums)).toEqual(
      tuples({
        income: [
          {
            locationId: a.principal.id,
            currency: 'USD',
            cents: 25_000,
            count: 2,
          },
        ],
        expenses: [
          {
            locationId: a.principal.id,
            currency: 'USD',
            category: 'Laboratorio',
            cents: 10_000,
            count: 1,
          },
          {
            locationId: a.principal.id,
            currency: 'USD',
            category: 'Insumos clínicos',
            cents: 5_000,
            count: 1,
          },
          {
            locationId: a.norte.id,
            currency: 'USD',
            category: 'Mensajería',
            cents: 4_000,
            count: 1,
          },
        ],
      }),
    );
  });

  it('Devengo: producción realizada − gastos no anulados por fecha de factura, pagados o no', async () => {
    const sums = await context.run(a.tenantId, () =>
      repo.sums(OCTOBER, 'ACCRUAL', [a.principal, a.norte]),
    );
    expect(tuples(sums)).toEqual(
      tuples({
        income: [
          {
            locationId: a.principal.id,
            currency: 'USD',
            cents: 38_000,
            count: 2,
          },
        ],
        expenses: [
          {
            locationId: a.principal.id,
            currency: 'USD',
            category: 'Laboratorio',
            cents: 12_000,
            count: 1,
          },
          {
            locationId: a.principal.id,
            currency: 'USD',
            category: 'Papelería',
            cents: 3_000,
            count: 1,
          },
          {
            locationId: a.principal.id,
            currency: 'VES',
            category: 'Alquiler',
            cents: 1_000_000,
            count: 1,
          },
          {
            locationId: a.norte.id,
            currency: 'USD',
            category: 'Mensajería',
            cents: 4_000,
            count: 1,
          },
        ],
      }),
    );
  });

  it('solo suma las sedes pedidas', async () => {
    const sums = await context.run(a.tenantId, () =>
      repo.sums(OCTOBER, 'CASH', [a.norte]),
    );
    expect(sums.income).toEqual([]);
    expect(sums.expenses.map((e) => e.locationId)).toEqual([a.norte.id]);
  });

  it('el detalle suma la cifra de la que sale, sin datos del paciente', async () => {
    const both = [a.principal, a.norte];
    const cases = [
      {
        basis: 'CASH',
        side: 'INCOME',
        currency: 'USD',
        cents: 25_000,
        count: 2,
      },
      {
        basis: 'ACCRUAL',
        side: 'INCOME',
        currency: 'USD',
        cents: 38_000,
        count: 2,
      },
      {
        basis: 'CASH',
        side: 'EXPENSE',
        currency: 'USD',
        cents: 19_000,
        count: 3,
      },
      {
        basis: 'ACCRUAL',
        side: 'EXPENSE',
        currency: 'USD',
        cents: 19_000,
        count: 3,
      },
      {
        basis: 'ACCRUAL',
        side: 'EXPENSE',
        currency: 'VES',
        cents: 1_000_000,
        count: 1,
      },
    ] as const;
    for (const c of cases) {
      const page = await context.run(a.tenantId, () =>
        repo.lines({
          period: OCTOBER,
          basis: c.basis,
          side: c.side,
          currency: c.currency,
          locations: both,
          page: 1,
          pageSize: 100,
        }),
      );
      expect([
        c.basis,
        c.side,
        c.currency,
        page.totalCents,
        page.count,
      ]).toEqual([c.basis, c.side, c.currency, c.cents, c.count]);
      expect(page.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(c.cents);
      for (const line of page.lines) {
        expect(Object.keys(line).sort()).toEqual(
          [
            'amountCents',
            'category',
            'concept',
            'date',
            'id',
            'locationId',
            'method',
            'paymentStatus',
          ].sort(),
        );
        expect(JSON.stringify(line)).not.toContain('dx410-a');
      }
    }
  });

  it('el detalle de cobros: día civil de la sede, del más reciente al más antiguo, y paginado', async () => {
    const run = (pageNo: number) =>
      context.run(a.tenantId, () =>
        repo.lines({
          period: OCTOBER,
          basis: 'CASH',
          side: 'INCOME',
          currency: 'USD',
          locations: [a.principal],
          page: pageNo,
          pageSize: 1,
        }),
      );
    const first = await run(1);
    const second = await run(2);
    expect(first.count).toBe(2);
    expect(first.lines.map((l) => [l.date, l.amountCents])).toEqual([
      ['2026-10-31', 5_000],
    ]);
    expect(second.lines.map((l) => [l.date, l.amountCents])).toEqual([
      ['2026-10-06', 20_000],
    ]);
    // Sin recibo numerado: la referencia antigua, nunca el paciente.
    expect(first.lines[0].concept).toMatch(/^REC-/);
  });

  it('el detalle de gastos en devengo: categoría, proveedor y si están pagados', async () => {
    const lines = async (category: string) =>
      (
        await context.run(a.tenantId, () =>
          repo.lines({
            period: OCTOBER,
            basis: 'ACCRUAL',
            side: 'EXPENSE',
            currency: 'USD',
            category,
            locations: [a.principal, a.norte],
            page: 1,
            pageSize: 25,
          }),
        )
      ).lines;
    expect(await lines('Laboratorio')).toEqual([
      expect.objectContaining({
        date: '2026-10-03',
        amountCents: 12_000,
        concept: 'Laboratorio Dental Ávila',
        category: 'Laboratorio',
        paymentStatus: 'PAID',
      }),
    ]);
    expect((await lines('Papelería'))[0].paymentStatus).toBe('UNPAID');
    // Caja: los pagos del gasto, con su medio.
    const cash = await context.run(a.tenantId, () =>
      repo.lines({
        period: OCTOBER,
        basis: 'CASH',
        side: 'EXPENSE',
        currency: 'USD',
        category: 'Laboratorio',
        locations: [a.principal],
        page: 1,
        pageSize: 25,
      }),
    );
    expect(cash.lines).toEqual([
      expect.objectContaining({
        date: '2026-10-04',
        amountCents: 10_000,
        method: 'Transferencia',
        paymentStatus: null,
      }),
    ]);
  });

  it('las sedes son solo las vivas de la clínica en contexto, en orden de creación', async () => {
    const inA = await context.run(a.tenantId, () => repo.listLocations('ALL'));
    expect(inA.map((l) => l.id)).toEqual([a.principal.id, a.norte.id]);
    expect(inA[0].timeZone).toBe('America/Caracas');
    const filtered = await context.run(a.tenantId, () =>
      repo.listLocations([b.principal.id]),
    );
    expect(filtered).toEqual([]);
  });

  it('con las sedes de otra clínica no devuelve nada de ella', async () => {
    for (const basis of ['CASH', 'ACCRUAL'] as const) {
      const sums = await context.run(a.tenantId, () =>
        repo.sums(OCTOBER, basis, [b.principal, b.norte]),
      );
      expect(sums).toEqual({ income: [], expenses: [] });
    }
  });

  it('la RLS sola ya aísla: filtro explícito de B con la clínica A fijada → nada', async () => {
    const asB = new TenantContextService();
    const crossed = new PrismaProfitabilityRepository(prisma, asB);
    for (const basis of ['CASH', 'ACCRUAL'] as const) {
      const sums = await context.run(a.tenantId, () =>
        asB.run(b.tenantId, () =>
          // `prisma` resuelve el tenant de `context` (A) para la RLS.
          crossed.sums(OCTOBER, basis, [b.principal, b.norte]),
        ),
      );
      expect(sums).toEqual({ income: [], expenses: [] });
      const page = await context.run(a.tenantId, () =>
        asB.run(b.tenantId, () =>
          crossed.lines({
            period: OCTOBER,
            basis,
            side: 'EXPENSE',
            currency: 'USD',
            locations: [b.principal, b.norte],
            page: 1,
            pageSize: 25,
          }),
        ),
      );
      expect(page).toEqual({ totalCents: 0, count: 0, lines: [] });
    }
    // Control: con su propia clínica fijada, B sí ve lo suyo.
    const own = await context.run(b.tenantId, () =>
      repo.sums(OCTOBER, 'CASH', [b.principal]),
    );
    expect(own.income).toEqual([
      {
        locationId: b.principal.id,
        currency: 'USD',
        cents: 25_000_000,
        count: 2,
      },
    ]);
  });

  it('sin clínica en contexto no consulta', async () => {
    await expect(repo.sums(OCTOBER, 'CASH', [a.principal])).rejects.toThrow(
      'No tenant in context',
    );
  });
});
