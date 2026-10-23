import { Prisma } from '@prisma/client';
import { categoryKey } from '../../domain/expense-categories';
import type { ExpenseListFilters } from '../../domain/ports/expense-repository.port';

/** Fila de la lista tal como la devuelve el SQL (bigint = céntimos). */
export interface ExpenseListRow {
  id: string;
  locationId: string;
  category: string;
  supplier: string | null;
  description: string | null;
  amountCents: bigint;
  currency: string;
  invoiceDate: Date;
  dueDate: Date | null;
  attachmentKey: string | null;
  attachmentMime: string | null;
  attachmentSize: number | null;
  attachmentSha256: string | null;
  attachmentName: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  voidedAt: Date | null;
  voidedById: string | null;
  voidReason: string | null;
  paidCents: bigint;
}

export interface ListQueryArgs {
  tenantId: string;
  filters: ExpenseListFilters;
  /** Sedes visibles para el usuario; `undefined` = todas. */
  scope: string[] | undefined;
  /** Día civil de HOY en cada sede de la clínica. */
  todays: { ids: string[]; days: string[] };
}

/**
 * Base de la lista: cada gasto con lo pagado (UNA agregación lateral por
 * fila, sin N+1), su estado derivado y si está vencido con el «hoy» de SU
 * sede. Filtra por todo lo que sale de columnas; el estado se filtra fuera,
 * sobre lo derivado. Mismas reglas que `expenseStatus`.
 */
function baseCte(args: ListQueryArgs): Prisma.Sql {
  const { filters, scope, tenantId } = args;
  const where: Prisma.Sql[] = [Prisma.sql`e."tenantId" = ${tenantId}::uuid`];
  if (scope !== undefined) {
    where.push(Prisma.sql`e."locationId" = ANY(${scope}::uuid[])`);
  }
  if (filters.locationId) {
    where.push(Prisma.sql`e."locationId" = ${filters.locationId}::uuid`);
  }
  if (filters.from) {
    where.push(Prisma.sql`e."invoiceDate" >= ${filters.from}::date`);
  }
  if (filters.to) {
    where.push(Prisma.sql`e."invoiceDate" <= ${filters.to}::date`);
  }
  if (filters.category) {
    where.push(
      Prisma.sql`public.dx_search_normalize(e."category") = ${categoryKey(filters.category)}`,
    );
  }
  if (filters.query) {
    // `position` en vez de LIKE: sin comodines que escapar.
    where.push(
      Prisma.sql`position(${categoryKey(filters.query)} in public.dx_search_normalize(coalesce(e."supplier", '') || ' ' || coalesce(e."description", ''))) > 0`,
    );
  }
  return Prisma.sql`
    WITH loc_today AS (
      SELECT t.id, t.day FROM unnest(${args.todays.ids}::uuid[], ${args.todays.days}::date[]) AS t(id, day)
    ), base AS (
      SELECT e."id", e."locationId", e."category", e."supplier", e."description",
             (e."amount" * 100)::bigint AS "amountCents", e."currency",
             e."invoiceDate", e."dueDate",
             e."attachmentKey", e."attachmentMime", e."attachmentSize",
             e."attachmentSha256", e."attachmentName",
             e."createdById", e."createdAt", e."updatedAt",
             e."voidedAt", e."voidedById", e."voidReason",
             p."paidCents",
             CASE WHEN e."voidedAt" IS NOT NULL THEN 'VOIDED'
                  WHEN p."paidCents" >= e."amount" * 100 THEN 'PAID'
                  WHEN p."paidCents" > 0 THEN 'PARTIAL'
                  ELSE 'PENDING' END AS "status",
             (e."voidedAt" IS NULL
              AND p."paidCents" < e."amount" * 100
              AND e."dueDate" IS NOT NULL
              AND e."dueDate" < COALESCE(t.day, CURRENT_DATE)) AS "overdue"
        FROM "expenses" e
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(ROUND(x."amount" * 100)), 0)::bigint AS "paidCents"
            FROM "expense_payments" x
           WHERE x."tenantId" = e."tenantId" AND x."expenseId" = e."id"
             AND x."voidedAt" IS NULL
        ) p
        LEFT JOIN loc_today t ON t.id = e."locationId"
       WHERE ${Prisma.join(where, ' AND ')}
    )`;
}

/** Filtro sobre el estado y el vencimiento derivados. */
function derivedFilter(filters: ExpenseListFilters): Prisma.Sql {
  const where: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (filters.status === 'OPEN') {
    where.push(Prisma.sql`"status" IN ('PENDING', 'PARTIAL')`);
  } else if (filters.status) {
    where.push(Prisma.sql`"status" = ${filters.status}`);
  }
  if (filters.overdue === true) where.push(Prisma.sql`"overdue"`);
  if (filters.overdue === false) where.push(Prisma.sql`NOT "overdue"`);
  return Prisma.join(where, ' AND ');
}

export function pageQuery(args: ListQueryArgs): Prisma.Sql {
  const { page, pageSize } = args.filters;
  return Prisma.sql`${baseCte(args)}
    SELECT * FROM base WHERE ${derivedFilter(args.filters)}
     ORDER BY "invoiceDate" DESC, "createdAt" DESC, "id" DESC
     LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
}

export function countQuery(args: ListQueryArgs): Prisma.Sql {
  return Prisma.sql`${baseCte(args)}
    SELECT count(*)::int AS "total" FROM base WHERE ${derivedFilter(args.filters)}`;
}
