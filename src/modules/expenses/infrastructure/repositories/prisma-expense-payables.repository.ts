import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  firstLocationWithRows,
  loadPeriodLocationZones,
} from '../../../../shared/locations/location-time-zone';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { civilDateIn } from '../../../../shared/time/civil-day';
import {
  PAYABLES_MONTH_DAYS,
  PAYABLES_SOON_DAYS,
} from '../../domain/expense-payables';
import type {
  ExpensePayablesRepository,
  PayableExpenses,
  PayableExpensesQuery,
  PayableSupplierRow,
  PayablesQuery,
} from '../../domain/ports/expense-payables-repository.port';
import {
  type ExpenseListRow,
  payableExpensesQuery,
} from './expense-list-query';
import { mapExpense } from './expense-mappers';

interface RawPayableRow {
  supplierKey: string;
  supplier: string | null;
  currency: string;
  openCount: number;
  pendingCents: bigint;
  overdueCount: number;
  overdueCents: bigint;
  dueIn7DaysCount: number;
  dueIn7DaysCents: bigint;
  dueIn30DaysCount: number;
  dueIn30DaysCents: bigint;
  noDueDateCount: number;
  noDueDateCents: bigint;
  oldestDueDate: Date | null;
}

/** «Hoy» de cada sede: los dos arrays paralelos que lee `unnest`. */
interface Todays {
  ids: string[];
  days: string[];
}

/**
 * Cuentas por pagar por proveedor (DX-411). Lee como `dentalix_app` dentro de
 * `runWithTenant` (RLS) y además filtra por `tenantId` y por las sedes
 * visibles del usuario.
 */
@Injectable()
export class PrismaExpensePayablesRepository implements ExpensePayablesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  /** Las sedes de la consulta: las visibles, acotadas a la pedida; `[]` = ninguna. */
  private scopeOf(requested: string | undefined): string[] | undefined {
    const visible = this.tenantContext.scopeLocationIds();
    if (!requested) return visible;
    if (visible !== undefined && !visible.includes(requested)) return [];
    return [requested];
  }

  /**
   * El día civil de hoy en cada sede del alcance. Una sede sin zona y sin
   * gastos se ignora; con gastos, 409 (como la lista de gastos).
   */
  private async todaysIn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    scope: string[] | undefined,
    now: Date,
  ): Promise<Todays> {
    const zones = await loadPeriodLocationZones(
      tx,
      tenantId,
      scope,
      firstLocationWithRows(tx.expense, tenantId),
    );
    const ids = [...zones.configured.keys()];
    const days = [...zones.configured.values()].map((zone) =>
      civilDateIn(now, zone),
    );
    return { ids, days };
  }

  async payables(
    query: PayablesQuery,
    now: Date,
  ): Promise<PayableSupplierRow[]> {
    const tenantId = this.requireTenantId();
    const scope = this.scopeOf(query.locationId);
    if (scope?.length === 0) return [];
    const onlyScope =
      scope === undefined
        ? Prisma.empty
        : Prisma.sql`AND e."locationId" = ANY(${scope}::uuid[])`;
    const onlyCurrency = query.currency
      ? Prisma.sql`AND e."currency" = ${query.currency}`
      : Prisma.empty;
    const paymentsScope =
      scope === undefined
        ? Prisma.empty
        : Prisma.sql`AND x."locationId" = ANY(${scope}::uuid[])`;
    const paymentsCurrency = query.currency
      ? Prisma.sql`AND x."currency" = ${query.currency}`
      : Prisma.empty;
    const rows = await this.prisma.runWithTenant(async (tx) => {
      const todays = await this.todaysIn(tx, tenantId, scope, now);
      // Pagado = pagos VIVOS, sumados por conjuntos (una agregación por gasto
      // y un hash join): con 40 000 gastos es la mitad que una suma lateral
      // por fila. Mismas reglas que la lista: abierto si lo pagado no cubre
      // el importe. No hay filtro por vencimiento que podar: el pendiente
      // cuenta todos los abiertos, así que un índice por vencimiento no se
      // usaría (DX-411, EXPLAIN en el PR).
      return tx.$queryRaw<RawPayableRow[]>`
        WITH loc_today AS (
          SELECT t.id, t.day
            FROM unnest(${todays.ids}::uuid[], ${todays.days}::date[]) AS t(id, day)
        ), paid AS (
          SELECT x."expenseId", SUM(ROUND(x."amount" * 100))::bigint AS "paidCents"
            FROM "expense_payments" x
           WHERE x."tenantId" = ${tenantId}::uuid
             AND x."voidedAt" IS NULL
             ${paymentsScope}
             ${paymentsCurrency}
           GROUP BY x."expenseId"
        ), open_expenses AS (
          SELECT e."id", e."supplier", e."currency", e."dueDate", e."createdAt",
                 public.dx_search_normalize(coalesce(e."supplier", '')) AS "key",
                 (e."amount" * 100)::bigint - COALESCE(p."paidCents", 0) AS "pendingCents",
                 t.day AS "today"
            FROM "expenses" e
            LEFT JOIN paid p ON p."expenseId" = e."id"
            LEFT JOIN loc_today t ON t.id = e."locationId"
           WHERE e."tenantId" = ${tenantId}::uuid
             AND e."voidedAt" IS NULL
             ${onlyScope}
             ${onlyCurrency}
             AND COALESCE(p."paidCents", 0) < e."amount" * 100
        )
        SELECT o."key" AS "supplierKey",
               (array_agg(o."supplier" ORDER BY o."createdAt" DESC, o."id" DESC))[1] AS "supplier",
               o."currency",
               count(*)::int AS "openCount",
               SUM(o."pendingCents")::bigint AS "pendingCents",
               count(*) FILTER (WHERE o."dueDate" < o."today")::int AS "overdueCount",
               COALESCE(SUM(o."pendingCents") FILTER (WHERE o."dueDate" < o."today"), 0)::bigint AS "overdueCents",
               count(*) FILTER (WHERE o."dueDate" >= o."today" AND o."dueDate" < o."today" + ${PAYABLES_SOON_DAYS}::int)::int AS "dueIn7DaysCount",
               COALESCE(SUM(o."pendingCents") FILTER (WHERE o."dueDate" >= o."today" AND o."dueDate" < o."today" + ${PAYABLES_SOON_DAYS}::int), 0)::bigint AS "dueIn7DaysCents",
               count(*) FILTER (WHERE o."dueDate" >= o."today" AND o."dueDate" < o."today" + ${PAYABLES_MONTH_DAYS}::int)::int AS "dueIn30DaysCount",
               COALESCE(SUM(o."pendingCents") FILTER (WHERE o."dueDate" >= o."today" AND o."dueDate" < o."today" + ${PAYABLES_MONTH_DAYS}::int), 0)::bigint AS "dueIn30DaysCents",
               count(*) FILTER (WHERE o."dueDate" IS NULL)::int AS "noDueDateCount",
               COALESCE(SUM(o."pendingCents") FILTER (WHERE o."dueDate" IS NULL), 0)::bigint AS "noDueDateCents",
               MIN(o."dueDate") AS "oldestDueDate"
          FROM open_expenses o
         GROUP BY o."key", o."currency"`;
    });
    return rows.map((r) => ({
      ...r,
      pendingCents: Number(r.pendingCents),
      overdueCents: Number(r.overdueCents),
      dueIn7DaysCents: Number(r.dueIn7DaysCents),
      dueIn30DaysCents: Number(r.dueIn30DaysCents),
      noDueDateCents: Number(r.noDueDateCents),
      oldestDueDate: r.oldestDueDate
        ? r.oldestDueDate.toISOString().slice(0, 10)
        : null,
    }));
  }

  async payableExpenses(
    query: PayableExpensesQuery,
    now: Date,
  ): Promise<PayableExpenses> {
    const tenantId = this.requireTenantId();
    const scope = this.scopeOf(query.locationId);
    if (scope?.length === 0) return { items: [], total: 0 };
    return this.prisma.runWithTenant(async (tx) => {
      const todays = await this.todaysIn(tx, tenantId, scope, now);
      const zoneDay = new Map(todays.ids.map((id, i) => [id, todays.days[i]]));
      const rows = await tx.$queryRaw<(ExpenseListRow & { total: number })[]>(
        payableExpensesQuery(
          {
            tenantId,
            filters: { page: 1, pageSize: query.limit },
            scope,
            todays,
          },
          query,
        ),
      );
      return {
        total: rows[0]?.total ?? 0,
        items: rows.map((row) =>
          mapExpense(
            { ...row, amountCents: Number(row.amountCents) },
            Number(row.paidCents),
            // Toda sede con gastos tiene zona (si no, `todaysIn` ya dio 409).
            zoneDay.get(row.locationId) ?? '',
          ),
        ),
      };
    });
  }
}
