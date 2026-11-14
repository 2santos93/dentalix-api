import { Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AllowedLocations } from '../../../shared/tenancy/location-access';
import { loadPeriodLocationZones } from '../../../shared/locations/location-time-zone';
import {
  civilDateIn,
  civilPeriodByZone,
  type ZonedPeriodBranch,
} from '../../../shared/time/civil-day';
import {
  formatReceiptNumber,
  legacyReceiptReference,
} from '../../payments/domain/receipt-number';
import { inPeriod, periodWindow } from './zoned-period-sql';
import type { CivilPeriod } from '../domain/comparison-period';
import {
  expensePaymentStatus,
  type ProfitabilityBasis,
  type ProfitabilityLocation,
} from '../domain/profitability';
import type {
  ProfitabilityLine,
  ProfitabilityLinesPage,
  ProfitabilityLinesQuery,
  ProfitabilityRepository,
  ProfitabilitySums,
} from '../domain/ports/profitability-repository.port';

interface SumRow {
  locationId: string;
  currency: string;
  category?: string;
  cents: bigint;
  count: bigint;
}

interface TotalRow {
  cents: bigint | null;
  count: bigint;
}

interface IncomePaymentRow {
  id: string;
  locationId: string;
  instant: Date;
  cents: bigint;
  seriesPrefix: string | null;
  number: number | null;
  methodName: string | null;
  legacyMethod: PaymentMethod | null;
}

interface IncomeItemRow {
  id: string;
  locationId: string;
  instant: Date;
  cents: bigint;
  code: string;
  label: string;
}

interface ExpenseLineRow {
  id: string;
  locationId: string;
  day: string;
  cents: bigint;
  category: string;
  supplier: string | null;
  description: string | null;
  method: PaymentMethod | null;
  paidCents: bigint | null;
}

/** El método de un abono sin medio del catálogo, o de un pago de gasto. */
const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Efectivo',
  CARD: 'Tarjeta',
  TRANSFER: 'Transferencia',
  OTHER: 'Otro',
};

const cents = (value: bigint | null): number => Number(value ?? 0);

/**
 * Sumas y detalle de «Rentabilidad por sede» (DX-410). Cada fuente es UNA
 * consulta agregada (GROUP BY sede, moneda y, en los gastos, categoría), con
 * el tenant explícito además de la RLS, en una transacción REPEATABLE READ:
 * ingresos y gastos de la misma foto, para que el resultado cuadre.
 *
 *  - Caja, ingresos: abonos con `deletedAt` NULL (anulados = `deletedAt`,
 *    SEC-013) por `paidAt` en el día civil de su sede (DX-097);
 *    `payments_tenantId_locationId_paidAt_active_idx`.
 *  - Caja, gastos: `expense_payments` con `voidedAt` NULL por `paidOn` (día
 *    civil), con la categoría de su gasto (anular un gasto anula sus pagos,
 *    DX-393); `expense_payments_tenant_location_paid_on_idx` (DX-410).
 *  - Devengo, ingresos: ítems DONE vivos de planes vivos con `completedAt` en
 *    el período, en `performedLocationId` (DX-050) y la moneda del plan, a
 *    precio − descuento (la producción de «Comparar sedes», DX-014);
 *    `treatment_plan_items_tenant_performed_location_idx`.
 *  - Devengo, gastos: `expenses` con `voidedAt` NULL por `invoiceDate` (día
 *    civil), pagados o no; `expenses_tenant_location_invoice_idx`.
 *
 * El detalle (`lines`) usa EXACTAMENTE los mismos filtros, así que sus filas
 * suman la cifra de la que salen. Ninguna consulta lee el paciente.
 */
@Injectable()
export class PrismaProfitabilityRepository implements ProfitabilityRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async listLocations(
    allowed: AllowedLocations,
  ): Promise<ProfitabilityLocation[]> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.location.findMany({
        where: {
          tenantId,
          deletedAt: null,
          ...(allowed === 'ALL' ? {} : { id: { in: [...allowed] } }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, isActive: true },
      });
      const zones = await loadPeriodLocationZones(
        tx,
        tenantId,
        rows.map((r) => r.id),
        (ids) => this.firstLocationWithMoney(tx, tenantId, ids),
      );
      // Una sede sin zona y sin movimientos no entra en el informe (G1).
      return rows
        .filter((r) => zones.configured.has(r.id))
        .map((r) => ({ ...r, timeZone: zones.zoneOf(r.id) }));
    });
  }

  /** La primera de las sedes con abonos, realizados o gastos, o null. */
  private async firstLocationWithMoney(
    tx: Prisma.TransactionClient,
    tenantId: string,
    locationIds: string[],
  ): Promise<string | null> {
    const [found] = await tx.$queryRaw<{ locationId: string }[]>`
      SELECT x."locationId" FROM (
        SELECT pay."locationId" FROM "payments" pay
         WHERE pay."tenantId" = ${tenantId}::uuid
           AND pay."locationId" = ANY(${locationIds}::uuid[])
        UNION ALL
        SELECT i."performedLocationId" FROM "treatment_plan_items" i
         WHERE i."tenantId" = ${tenantId}::uuid
           AND i."performedLocationId" = ANY(${locationIds}::uuid[])
        UNION ALL
        SELECT e."locationId" FROM "expenses" e
         WHERE e."tenantId" = ${tenantId}::uuid
           AND e."locationId" = ANY(${locationIds}::uuid[])
      ) x
      LIMIT 1`;
    return found?.locationId ?? null;
  }

  async sums(
    period: CivilPeriod,
    basis: ProfitabilityBasis,
    locations: readonly ProfitabilityLocation[],
  ): Promise<ProfitabilitySums> {
    const tenantId = this.requireTenantId();
    if (locations.length === 0) return { income: [], expenses: [] };
    const ids = locations.map((l) => l.id);
    const branches = branchesOf(period, locations);
    return this.prisma.runWithTenant(
      async (tx) => {
        // En orden: una transacción interactiva usa una sola conexión.
        const income =
          basis === 'CASH'
            ? await tx.$queryRaw<SumRow[]>`
          SELECT pay."locationId", pay."currency",
                 COALESCE(SUM(ROUND(pay."amount" * 100)), 0)::bigint AS "cents",
                 count(*) AS "count"
            FROM "payments" pay
           WHERE ${cashIncomeWhere(tenantId, branches)}
           GROUP BY 1, 2`
            : await tx.$queryRaw<SumRow[]>`
          SELECT i."performedLocationId" AS "locationId", p."currency",
                 COALESCE(SUM(ROUND((i."price" - i."discount") * 100)), 0)::bigint AS "cents",
                 count(*) AS "count"
            FROM "treatment_plan_items" i
            JOIN "treatment_plans" p
              ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
           WHERE ${accrualIncomeWhere(tenantId, ids, branches)}
           GROUP BY 1, 2`;
        const expenses =
          basis === 'CASH'
            ? await tx.$queryRaw<SumRow[]>`
          SELECT ep."locationId", ep."currency", e."category",
                 COALESCE(SUM(ROUND(ep."amount" * 100)), 0)::bigint AS "cents",
                 count(*) AS "count"
            FROM "expense_payments" ep
            JOIN "expenses" e
              ON e."tenantId" = ep."tenantId" AND e."id" = ep."expenseId"
           WHERE ${cashExpenseWhere(tenantId, ids, period)}
           GROUP BY 1, 2, 3`
            : await tx.$queryRaw<SumRow[]>`
          SELECT e."locationId", e."currency", e."category",
                 COALESCE(SUM(ROUND(e."amount" * 100)), 0)::bigint AS "cents",
                 count(*) AS "count"
            FROM "expenses" e
           WHERE ${accrualExpenseWhere(tenantId, ids, period)}
           GROUP BY 1, 2, 3`;
        return {
          income: income.map((r) => ({
            locationId: r.locationId,
            currency: r.currency,
            cents: cents(r.cents),
            count: Number(r.count),
          })),
          expenses: expenses.map((r) => ({
            locationId: r.locationId,
            currency: r.currency,
            category: r.category ?? '',
            cents: cents(r.cents),
            count: Number(r.count),
          })),
        };
      },
      // Ingresos y gastos de la misma foto: el resultado tiene que cuadrar.
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async lines(query: ProfitabilityLinesQuery): Promise<ProfitabilityLinesPage> {
    const tenantId = this.requireTenantId();
    if (query.locations.length === 0) {
      return { totalCents: 0, count: 0, lines: [] };
    }
    const ids = query.locations.map((l) => l.id);
    const zoneOf = new Map(query.locations.map((l) => [l.id, l.timeZone]));
    const branches = branchesOf(query.period, query.locations);
    const offset = (query.page - 1) * query.pageSize;
    const limit = query.pageSize;
    const currency = query.currency;
    const category =
      query.category === undefined
        ? Prisma.empty
        : Prisma.sql`AND e."category" = ${query.category}`;
    const civilOf = (r: { locationId: string; instant: Date }): string =>
      civilDateIn(r.instant, zoneOf.get(r.locationId) ?? 'UTC');

    return this.prisma.runWithTenant(
      async (tx) => {
        if (query.side === 'INCOME' && query.basis === 'CASH') {
          const where = Prisma.sql`${cashIncomeWhere(tenantId, branches)} AND pay."currency" = ${currency}`;
          const [total] = await tx.$queryRaw<TotalRow[]>`
            SELECT SUM(ROUND(pay."amount" * 100))::bigint AS "cents", count(*) AS "count"
              FROM "payments" pay WHERE ${where}`;
          const rows = await tx.$queryRaw<IncomePaymentRow[]>`
            SELECT pay."id", pay."locationId", pay."paidAt" AS "instant",
                   ROUND(pay."amount" * 100)::bigint AS "cents",
                   r."seriesPrefix", r."number",
                   pm."name" AS "methodName", pay."method" AS "legacyMethod"
              FROM "payments" pay
              LEFT JOIN "payment_receipts" r
                ON r."tenantId" = pay."tenantId" AND r."paymentId" = pay."id"
              LEFT JOIN "payment_methods" pm
                ON pm."tenantId" = pay."tenantId" AND pm."id" = pay."paymentMethodId"
             WHERE ${where}
             ORDER BY pay."paidAt" DESC, pay."id" DESC
             LIMIT ${limit} OFFSET ${offset}`;
          return page(
            total,
            rows.map((r): ProfitabilityLine => ({
              id: r.id,
              date: civilOf(r),
              locationId: r.locationId,
              amountCents: cents(r.cents),
              concept:
                r.seriesPrefix !== null && r.number !== null
                  ? formatReceiptNumber(r.seriesPrefix, r.number)
                  : legacyReceiptReference(r.id),
              category: null,
              method:
                r.methodName ??
                (r.legacyMethod ? METHOD_LABELS[r.legacyMethod] : null),
              paymentStatus: null,
            })),
          );
        }
        if (query.side === 'INCOME') {
          const where = Prisma.sql`${accrualIncomeWhere(tenantId, ids, branches)} AND p."currency" = ${currency}`;
          const [total] = await tx.$queryRaw<TotalRow[]>`
            SELECT SUM(ROUND((i."price" - i."discount") * 100))::bigint AS "cents", count(*) AS "count"
              FROM "treatment_plan_items" i
              JOIN "treatment_plans" p
                ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
             WHERE ${where}`;
          const rows = await tx.$queryRaw<IncomeItemRow[]>`
            SELECT i."id", i."performedLocationId" AS "locationId",
                   i."completedAt" AS "instant",
                   ROUND((i."price" - i."discount") * 100)::bigint AS "cents",
                   c."code", c."labelEs" AS "label"
              FROM "treatment_plan_items" i
              JOIN "treatment_plans" p
                ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
              JOIN "dental_catalog_items" c
                ON c."tenantId" = i."tenantId" AND c."id" = i."catalogItemId"
             WHERE ${where}
             ORDER BY i."completedAt" DESC, i."id" DESC
             LIMIT ${limit} OFFSET ${offset}`;
          return page(
            total,
            rows.map((r): ProfitabilityLine => ({
              id: r.id,
              date: civilOf(r),
              locationId: r.locationId,
              amountCents: cents(r.cents),
              concept: `${r.code} · ${r.label}`,
              category: null,
              method: null,
              paymentStatus: null,
            })),
          );
        }
        if (query.basis === 'CASH') {
          const where = Prisma.sql`${cashExpenseWhere(tenantId, ids, query.period)} AND ep."currency" = ${currency} ${category}`;
          const [total] = await tx.$queryRaw<TotalRow[]>`
            SELECT SUM(ROUND(ep."amount" * 100))::bigint AS "cents", count(*) AS "count"
              FROM "expense_payments" ep
              JOIN "expenses" e
                ON e."tenantId" = ep."tenantId" AND e."id" = ep."expenseId"
             WHERE ${where}`;
          const rows = await tx.$queryRaw<ExpenseLineRow[]>`
            SELECT ep."id", ep."locationId",
                   to_char(ep."paidOn", 'YYYY-MM-DD') AS "day",
                   ROUND(ep."amount" * 100)::bigint AS "cents",
                   e."category", e."supplier", e."description",
                   ep."method", NULL::bigint AS "paidCents"
              FROM "expense_payments" ep
              JOIN "expenses" e
                ON e."tenantId" = ep."tenantId" AND e."id" = ep."expenseId"
             WHERE ${where}
             ORDER BY ep."paidOn" DESC, ep."createdAt" DESC, ep."id" DESC
             LIMIT ${limit} OFFSET ${offset}`;
          return page(total, rows.map(expenseLine));
        }
        const where = Prisma.sql`${accrualExpenseWhere(tenantId, ids, query.period)} AND e."currency" = ${currency} ${category}`;
        const [total] = await tx.$queryRaw<TotalRow[]>`
          SELECT SUM(ROUND(e."amount" * 100))::bigint AS "cents", count(*) AS "count"
            FROM "expenses" e WHERE ${where}`;
        const rows = await tx.$queryRaw<ExpenseLineRow[]>`
          SELECT e."id", e."locationId",
                 to_char(e."invoiceDate", 'YYYY-MM-DD') AS "day",
                 ROUND(e."amount" * 100)::bigint AS "cents",
                 e."category", e."supplier", e."description",
                 NULL::"PaymentMethod" AS "method",
                 (SELECT COALESCE(SUM(ROUND(ep."amount" * 100)), 0)::bigint
                    FROM "expense_payments" ep
                   WHERE ep."tenantId" = e."tenantId"
                     AND ep."expenseId" = e."id"
                     AND ep."voidedAt" IS NULL) AS "paidCents"
            FROM "expenses" e
           WHERE ${where}
           ORDER BY e."invoiceDate" DESC, e."createdAt" DESC, e."id" DESC
           LIMIT ${limit} OFFSET ${offset}`;
        return page(total, rows.map(expenseLine));
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

/** Las ramas por zona del período (DX-097) de las sedes de la consulta. */
function branchesOf(
  period: CivilPeriod,
  locations: readonly ProfitabilityLocation[],
): ZonedPeriodBranch[] {
  return civilPeriodByZone(
    period.from,
    period.to,
    new Map(locations.map((l) => [l.id, l.timeZone])),
  );
}

/** Abonos vivos con fecha de pago en el día civil de su sede. */
function cashIncomeWhere(
  tenantId: string,
  branches: readonly ZonedPeriodBranch[],
): Prisma.Sql {
  return Prisma.sql`pay."tenantId" = ${tenantId}::uuid
    AND pay."deletedAt" IS NULL
    AND ${inPeriod(Prisma.sql`pay."locationId"`, Prisma.sql`pay."paidAt"`, branches)}`;
}

/** Ítems realizados (DX-050) vivos, de planes vivos, en el período. */
function accrualIncomeWhere(
  tenantId: string,
  ids: readonly string[],
  branches: readonly ZonedPeriodBranch[],
): Prisma.Sql {
  const window = periodWindow(branches);
  return Prisma.sql`i."tenantId" = ${tenantId}::uuid
    AND i."status" = 'DONE'
    AND i."deletedAt" IS NULL
    AND p."deletedAt" IS NULL
    AND i."performedLocationId" = ANY(${ids}::uuid[])
    AND i."completedAt" >= ${window.start}
    AND i."completedAt" < ${window.end}
    AND ${inPeriod(Prisma.sql`i."performedLocationId"`, Prisma.sql`i."completedAt"`, branches)}`;
}

/** Pagos de gastos no anulados con `paidOn` (día civil) en el período. */
function cashExpenseWhere(
  tenantId: string,
  ids: readonly string[],
  period: CivilPeriod,
): Prisma.Sql {
  return Prisma.sql`ep."tenantId" = ${tenantId}::uuid
    AND ep."voidedAt" IS NULL
    AND ep."locationId" = ANY(${ids}::uuid[])
    AND ep."paidOn" >= ${period.from}::date
    AND ep."paidOn" <= ${period.to}::date`;
}

/** Gastos no anulados con fecha de factura (día civil) en el período. */
function accrualExpenseWhere(
  tenantId: string,
  ids: readonly string[],
  period: CivilPeriod,
): Prisma.Sql {
  return Prisma.sql`e."tenantId" = ${tenantId}::uuid
    AND e."voidedAt" IS NULL
    AND e."locationId" = ANY(${ids}::uuid[])
    AND e."invoiceDate" >= ${period.from}::date
    AND e."invoiceDate" <= ${period.to}::date`;
}

function expenseLine(r: ExpenseLineRow): ProfitabilityLine {
  return {
    id: r.id,
    date: r.day,
    locationId: r.locationId,
    amountCents: cents(r.cents),
    concept: r.supplier ?? r.description ?? null,
    category: r.category,
    method: r.method ? METHOD_LABELS[r.method] : null,
    paymentStatus:
      r.paidCents === null
        ? null
        : expensePaymentStatus(cents(r.cents), cents(r.paidCents)),
  };
}

function page(
  total: TotalRow | undefined,
  lines: ProfitabilityLine[],
): ProfitabilityLinesPage {
  return {
    totalCents: cents(total?.cents ?? null),
    count: Number(total?.count ?? 0),
    lines,
  };
}
