import { fromCents } from './expense-rules';
import type { PayableSupplierRow } from './ports/expense-payables-repository.port';

/*
 * Cuentas por pagar por proveedor (DX-411). Reglas:
 *
 * - Abierto: gasto no anulado cuyo importe supera lo pagado en pagos VIVOS
 *   (los anulados no cuentan). Pendiente = importe − pagado vivo.
 * - Proveedor: se agrupa por `dx_search_normalize(proveedor)` (sin espacios
 *   en los extremos, internos colapsados, sin mayúsculas ni tildes). Se
 *   muestra la grafía del gasto abierto más reciente (alta más reciente) del
 *   grupo. Sin proveedor → un grupo propio, «Sin proveedor».
 * - Moneda: una fila por proveedor × moneda; nunca se suman monedas.
 * - «Hoy» es el día civil en la zona horaria de la sede de CADA gasto.
 *   Vencido: vencimiento < hoy. Vence en 7 días: hoy ≤ vencimiento ≤ hoy + 6
 *   (los 7 días civiles que empiezan hoy). Vence en 30 días: hoy ≤
 *   vencimiento ≤ hoy + 29; incluye los de 7 días. Un vencido no está en
 *   ningún tramo «vence en». Sin vencimiento: cuenta en el pendiente y en su
 *   propio tramo, nunca como vencido ni en 7/30 días.
 */

/** Días civiles del tramo corto, hoy incluido. */
export const PAYABLES_SOON_DAYS = 7;
/** Días civiles del tramo largo, hoy incluido. */
export const PAYABLES_MONTH_DAYS = 30;
/** Cómo se rotula el grupo de los gastos sin proveedor. */
export const NO_SUPPLIER_LABEL = 'Sin proveedor';
/** Tope de gastos del detalle de un proveedor. */
export const PAYABLE_EXPENSES_LIMIT = 500;

export interface PayableAmounts {
  openCount: number;
  pending: number;
  overdueCount: number;
  overdue: number;
  dueIn7DaysCount: number;
  dueIn7Days: number;
  dueIn30DaysCount: number;
  dueIn30Days: number;
  noDueDateCount: number;
  noDueDate: number;
}

export interface PayableSupplierView extends PayableAmounts {
  supplierKey: string;
  /** `null` = «Sin proveedor». */
  supplier: string | null;
  currency: string;
  oldestDueDate: string | null;
}

export interface PayableCurrencyTotalView extends PayableAmounts {
  currency: string;
}

type Cents = Omit<
  PayableSupplierRow,
  'supplierKey' | 'supplier' | 'currency' | 'oldestDueDate'
>;

function amountsOf(c: Cents): PayableAmounts {
  return {
    openCount: c.openCount,
    pending: fromCents(c.pendingCents),
    overdueCount: c.overdueCount,
    overdue: fromCents(c.overdueCents),
    dueIn7DaysCount: c.dueIn7DaysCount,
    dueIn7Days: fromCents(c.dueIn7DaysCents),
    dueIn30DaysCount: c.dueIn30DaysCount,
    dueIn30Days: fromCents(c.dueIn30DaysCents),
    noDueDateCount: c.noDueDateCount,
    noDueDate: fromCents(c.noDueDateCents),
  };
}

const ZERO: Cents = {
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

function add(a: Cents, b: Cents): Cents {
  const sum = { ...a };
  for (const key of Object.keys(ZERO) as (keyof Cents)[]) sum[key] += b[key];
  return sum;
}

/**
 * Orden de las filas: lo más urgente primero (el vencimiento más antiguo; sin
 * ninguno, al final), luego el nombre («Sin proveedor» al final) y la moneda.
 */
export function comparePayableRows(
  a: PayableSupplierView,
  b: PayableSupplierView,
): number {
  if (a.oldestDueDate !== b.oldestDueDate) {
    if (a.oldestDueDate === null) return 1;
    if (b.oldestDueDate === null) return -1;
    return a.oldestDueDate < b.oldestDueDate ? -1 : 1;
  }
  if ((a.supplier === null) !== (b.supplier === null)) {
    return a.supplier === null ? 1 : -1;
  }
  return (
    (a.supplier ?? '').localeCompare(b.supplier ?? '', 'es') ||
    a.supplierKey.localeCompare(b.supplierKey) ||
    a.currency.localeCompare(b.currency)
  );
}

/** Filas ordenadas y totales por moneda (en orden alfabético de moneda). */
export function assemblePayables(rows: readonly PayableSupplierRow[]): {
  rows: PayableSupplierView[];
  totals: PayableCurrencyTotalView[];
} {
  const byCurrency = new Map<string, Cents>();
  const views = rows.map((row): PayableSupplierView => {
    byCurrency.set(
      row.currency,
      add(byCurrency.get(row.currency) ?? ZERO, row),
    );
    return {
      supplierKey: row.supplierKey,
      supplier: row.supplier,
      currency: row.currency,
      oldestDueDate: row.oldestDueDate,
      ...amountsOf(row),
    };
  });
  views.sort(comparePayableRows);
  const totals = [...byCurrency]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => ({ currency, ...amountsOf(cents) }));
  return { rows: views, totals };
}
