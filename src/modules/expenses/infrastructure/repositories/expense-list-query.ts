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

/** Lo que se filtra por columnas del gasto (`e`); el estado va aparte. */
function expenseWhere(args: ListQueryArgs): Prisma.Sql {
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
  return Prisma.join(where, ' AND ');
}

/**
 * Orden de la lista. Es el de los índices `expenses_tenant_invoice_created_idx`
 * y `expenses_tenant_location_invoice_created_idx` (DX-393): la página sale
 * del índice sin ordenar la clínica entera.
 */
const ORDER = Prisma.sql`"invoiceDate" DESC, "createdAt" DESC, "id" DESC`;

/** ¿Filtra por algo derivado de los pagos (estado o vencido)? */
function filtersDerived(filters: ExpenseListFilters): boolean {
  return filters.status !== undefined || filters.overdue !== undefined;
}

function pageWindow(filters: ExpenseListFilters): Prisma.Sql {
  const { page, pageSize } = filters;
  return Prisma.sql`LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
}

/**
 * Base de la lista: cada gasto de `picked` con lo pagado (UNA agregación
 * lateral por fila, sin N+1), su estado derivado y si está vencido con el
 * «hoy» de SU sede. Mismas reglas que `expenseStatus`.
 *
 * DX-393 (DB-059): sin filtro de estado ni de vencido, `picked` ya es la
 * página (`LIMIT` dentro, por el índice), así que solo se suman los pagos de
 * los gastos que se devuelven. Con esos filtros la suma decide qué filas
 * entran: `picked` son todos los gastos que pasan los filtros de columnas.
 */
function baseCte(args: ListQueryArgs, picked: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    WITH loc_today AS (
      SELECT t.id, t.day FROM unnest(${args.todays.ids}::uuid[], ${args.todays.days}::date[]) AS t(id, day)
    ), picked AS (
      SELECT e.* FROM "expenses" e WHERE ${expenseWhere(args)} ${picked}
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
              AND e."dueDate" < t.day) AS "overdue"
        FROM picked e
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(ROUND(x."amount" * 100)), 0)::bigint AS "paidCents"
            FROM "expense_payments" x
           WHERE x."tenantId" = e."tenantId" AND x."expenseId" = e."id"
             AND x."voidedAt" IS NULL
        ) p
        LEFT JOIN loc_today t ON t.id = e."locationId"
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
  const { filters } = args;
  if (!filtersDerived(filters)) {
    return Prisma.sql`${baseCte(args, Prisma.sql`ORDER BY ${ORDER} ${pageWindow(filters)}`)}
      SELECT * FROM base ORDER BY ${ORDER}`;
  }
  return Prisma.sql`${baseCte(args, Prisma.empty)}
    SELECT * FROM base WHERE ${derivedFilter(filters)}
     ORDER BY ${ORDER} ${pageWindow(filters)}`;
}

/** Total de la lista; sin filtro derivado no suma ningún pago. */
export function countQuery(args: ListQueryArgs): Prisma.Sql {
  if (!filtersDerived(args.filters)) {
    return Prisma.sql`SELECT count(*)::int AS "total" FROM "expenses" e WHERE ${expenseWhere(args)}`;
  }
  return Prisma.sql`${baseCte(args, Prisma.empty)}
    SELECT count(*)::int AS "total" FROM base WHERE ${derivedFilter(args.filters)}`;
}
