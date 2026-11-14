import type { Expense } from '../entities/expense.entity';

export const EXPENSE_PAYABLES_REPOSITORY = Symbol(
  'EXPENSE_PAYABLES_REPOSITORY',
);

export interface PayablesQuery {
  /** Sede pedida, dentro de las visibles; sin ella, todas las visibles. */
  locationId?: string;
  /** Código ISO 4217 en mayúsculas; sin él, todas las monedas. */
  currency?: string;
}

/**
 * Un proveedor (por su clave normalizada) en una moneda. Importes en
 * céntimos. Los tramos se cuentan con el día civil de HOY en la sede de cada
 * gasto (ver `expense-payables.ts`).
 */
export interface PayableSupplierRow {
  /** `dx_search_normalize(proveedor)`; `''` = gastos sin proveedor. */
  supplierKey: string;
  /** Grafía del gasto abierto más reciente del grupo; `null` = sin proveedor. */
  supplier: string | null;
  currency: string;
  openCount: number;
  pendingCents: number;
  overdueCount: number;
  overdueCents: number;
  dueIn7DaysCount: number;
  dueIn7DaysCents: number;
  dueIn30DaysCount: number;
  dueIn30DaysCents: number;
  noDueDateCount: number;
  noDueDateCents: number;
  /** El vencimiento más antiguo de sus gastos abiertos (AAAA-MM-DD) o null. */
  oldestDueDate: string | null;
}

export interface PayableExpensesQuery extends PayablesQuery {
  supplierKey: string;
  currency: string;
  limit: number;
}

export interface PayableExpenses {
  /** Por vencimiento (sin vencimiento al final), hasta `limit`. */
  items: Expense[];
  /** Cuántos gastos abiertos tiene el grupo en total. */
  total: number;
}

export interface ExpensePayablesRepository {
  /**
   * Gastos ABIERTOS (no anulados y con lo pagado en pagos vivos por debajo del
   * importe) de las sedes visibles, agrupados por proveedor normalizado y
   * moneda. Una sede pedida fuera de las visibles no devuelve nada.
   */
  payables(query: PayablesQuery, now: Date): Promise<PayableSupplierRow[]>;

  /** Los gastos abiertos de UN grupo (proveedor × moneda). */
  payableExpenses(
    query: PayableExpensesQuery,
    now: Date,
  ): Promise<PayableExpenses>;
}
