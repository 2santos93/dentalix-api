import { csvAmount, csvDocument, csvText } from '../../../shared/csv/csv-cells';
import {
  NO_SUPPLIER_LABEL,
  type PayableSupplierView,
} from '../domain/expense-payables';

/*
 * CSV de las cuentas por pagar por proveedor (DX-411): una línea por
 * proveedor × moneda, en el mismo orden que la pantalla. Mismo formato y
 * protecciones que el resto de CSV de gastos (BOM, CRLF, celdas contra
 * fórmulas, decimales de la moneda). Los importes son lo PENDIENTE.
 */
export const EXPENSE_PAYABLES_CSV_HEADER = [
  'Proveedor',
  'Moneda',
  'Gastos abiertos',
  'Pendiente',
  'Vencido',
  'Gastos vencidos',
  'Vence en 7 días',
  'Gastos que vencen en 7 días',
  'Vence en 30 días',
  'Gastos que vencen en 30 días',
  'Sin vencimiento',
  'Vencimiento más antiguo',
] as const;

export function toExpensePayablesCsv(
  rows: readonly PayableSupplierView[],
): string {
  const lines: string[] = [EXPENSE_PAYABLES_CSV_HEADER.join(',')];
  for (const row of rows) {
    const money = (value: number) => csvAmount(value, row.currency);
    lines.push(
      [
        csvText(row.supplier ?? NO_SUPPLIER_LABEL),
        row.currency,
        row.openCount,
        money(row.pending),
        money(row.overdue),
        row.overdueCount,
        money(row.dueIn7Days),
        row.dueIn7DaysCount,
        money(row.dueIn30Days),
        row.dueIn30DaysCount,
        money(row.noDueDate),
        row.oldestDueDate ?? '',
      ].join(','),
    );
  }
  return csvDocument(lines);
}
