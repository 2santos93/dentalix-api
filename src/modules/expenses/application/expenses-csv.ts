import { csvAmount, csvDocument, csvText } from '../../../shared/csv/csv-cells';
import { currencyDecimals } from '../../../shared/money/currency-decimals';
import type { ExpenseStatus } from '../domain/entities/expense.entity';
import type { ExpenseView } from './expense-view';

/*
 * CSV de gastos (DX-274): una línea por gasto con los mismos filtros que la
 * pantalla. Proveedor, descripción y categorías propias son texto libre: van
 * entre comillas, sin saltos de línea y protegidos contra fórmulas. Importes
 * con los decimales de su moneda. Solo ADMIN y la descarga queda auditada.
 */
export const EXPENSES_CSV_HEADER = [
  'Fecha de factura',
  'Vencimiento',
  'Sede',
  'Categoría',
  'Proveedor',
  'Descripción',
  'Moneda',
  'Importe',
  'Pagado',
  'Pendiente',
  'Estado',
  'Vencido',
] as const;

// Mismas etiquetas que la web.
export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  PENDING: 'Pendiente',
  PARTIAL: 'Parcial',
  PAID: 'Pagado',
  VOIDED: 'Anulado',
};

export function toExpensesCsv(
  rows: readonly ExpenseView[],
  locationNames: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [EXPENSES_CSV_HEADER.join(',')];
  for (const row of rows) {
    const money = (value: number) =>
      csvAmount(value, currencyDecimals(row.currency));
    lines.push(
      [
        row.invoiceDate,
        row.dueDate ?? '',
        csvText(locationNames.get(row.locationId) ?? ''),
        csvText(row.category),
        csvText(row.supplier),
        csvText(row.description),
        row.currency,
        money(row.amount),
        money(row.paidAmount),
        money(row.pendingAmount),
        EXPENSE_STATUS_LABELS[row.status],
        row.overdue ? 'Sí' : 'No',
      ].join(','),
    );
  }
  return csvDocument(lines);
}
