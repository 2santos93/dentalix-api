import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { loadLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { civilPeriodByZone } from '../../../../shared/time/civil-day';
import type {
  ExpenseSummaryData,
  ExpenseSummaryQuery,
  ExpenseSummaryRepository,
  SummaryExpenseRow,
  SummaryIncomeRow,
} from '../../domain/ports/expense-summary-repository.port';

interface RawRow {
  month: string;
  locationId: string;
  currency: string;
  category?: string;
  cents: bigint;
}

const EMPTY: ExpenseSummaryData = {
  locationNames: new Map(),
  income: [],
  expenses: [],
};

@Injectable()
export class PrismaExpenseSummaryRepository implements ExpenseSummaryRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  /** Las sedes del resumen: las visibles, acotadas a la pedida; `[]` = ninguna. */
  private scopeOf(requested: string | undefined): string[] | undefined {
    const visible = this.tenantContext.scopeLocationIds();
    if (!requested) return visible;
    if (visible !== undefined && !visible.includes(requested)) return [];
    return [requested];
  }

  async summarize(query: ExpenseSummaryQuery): Promise<ExpenseSummaryData> {
    const tenantId = this.requireTenantId();
    const scope = this.scopeOf(query.locationId);
    if (scope?.length === 0) return EMPTY;
    return this.prisma.runWithTenant(
      async (tx) => {
        // En orden: una transacción interactiva usa una sola conexión.
        const locations = await tx.location.findMany({
          select: { id: true, name: true },
        });
        const zones = await loadLocationTimeZones(tx, tenantId, scope);
        const income = await this.income(tx, tenantId, query, zones);
        const expenses = await this.expenses(tx, tenantId, query, scope);
        return {
          locationNames: new Map(locations.map((l) => [l.id, l.name])),
          income,
          expenses,
        };
      },
      // Ingresos y gastos de la misma foto: el neto tiene que cuadrar.
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * Abonos vivos por mes civil de SU sede: una consulta por zona horaria (lo
   * normal es una), con el rango en instantes para servir el índice por fecha.
   * `paidAt` es un `timestamp` en UTC: se declara UTC antes de pasarlo a la
   * zona de la sede.
   */
  private async income(
    tx: Prisma.TransactionClient,
    tenantId: string,
    query: ExpenseSummaryQuery,
    zones: Map<string, string>,
  ): Promise<SummaryIncomeRow[]> {
    const rows: SummaryIncomeRow[] = [];
    for (const branch of civilPeriodByZone(query.from, query.to, zones)) {
      const found = await tx.$queryRaw<RawRow[]>`
        SELECT to_char((p."paidAt" AT TIME ZONE 'UTC') AT TIME ZONE ${branch.timeZone}, 'YYYY-MM') AS "month",
               p."locationId", p."currency",
               COALESCE(SUM(ROUND(p."amount" * 100)), 0)::bigint AS "cents"
          FROM "payments" p
         WHERE p."tenantId" = ${tenantId}::uuid
           AND p."deletedAt" IS NULL
           AND p."locationId" = ANY(${branch.locationIds}::uuid[])
           AND p."paidAt" >= ${branch.start}
           AND p."paidAt" < ${branch.end}
         GROUP BY 1, 2, 3`;
      rows.push(...found.map((r) => ({ ...r, cents: Number(r.cents) })));
    }
    return rows;
  }

  /** Gastos no anulados por mes de su fecha de factura (devengado, R9). */
  private async expenses(
    tx: Prisma.TransactionClient,
    tenantId: string,
    query: ExpenseSummaryQuery,
    scope: string[] | undefined,
  ): Promise<SummaryExpenseRow[]> {
    const onlyScope =
      scope === undefined
        ? Prisma.empty
        : Prisma.sql`AND e."locationId" = ANY(${scope}::uuid[])`;
    const found = await tx.$queryRaw<RawRow[]>`
      SELECT to_char(e."invoiceDate", 'YYYY-MM') AS "month",
             e."locationId", e."currency", e."category",
             COALESCE(SUM(ROUND(e."amount" * 100)), 0)::bigint AS "cents"
        FROM "expenses" e
       WHERE e."tenantId" = ${tenantId}::uuid
         AND e."voidedAt" IS NULL
         AND e."invoiceDate" >= ${query.from}::date
         AND e."invoiceDate" <= ${query.to}::date
         ${onlyScope}
       GROUP BY 1, 2, 3, 4`;
    return found.map((r) => ({
      ...r,
      category: r.category ?? '',
      cents: Number(r.cents),
    }));
  }
}
