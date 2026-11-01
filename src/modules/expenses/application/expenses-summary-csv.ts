import { csvAmount, csvDocument, csvText } from '../../../shared/csv/csv-cells';
import type { CurrencyDigitsTable } from '../../../shared/money/currency-digits';
import type { ExpenseSummaryRowView } from './use-cases/get-expense-summary.use-case';

/*
 * CSV del resumen mensual (DX-274): por cada mes, sede y moneda, una línea de
 * «Ingresos», una por categoría de gasto, el «Total gastos» y el «Neto»
 * (ingresos − gastos). Mismo formato y protecciones que el CSV de gastos.
 */
export const EXPENSES_SUMMARY_CSV_HEADER = [
  'Mes',
  'Sede',
  'Moneda',
  'Concepto',
  'Categoría',
  'Importe',
] as const;

export function toExpensesSummaryCsv(
  rows: readonly ExpenseSummaryRowView[],
  digits: CurrencyDigitsTable,
): string {
  const lines: string[] = [EXPENSES_SUMMARY_CSV_HEADER.join(',')];
  for (const row of rows) {
    const line = (concept: string, category: string, amount: number) =>
      [
        row.month,
        csvText(row.locationName),
        row.currency,
        concept,
        csvText(category),
        csvAmount(amount, digits.roundingDigits(row.currency)),
      ].join(',');
    lines.push(line('Ingresos', '', row.income));
    for (const c of row.categories) {
      lines.push(line('Gasto', c.category, c.amount));
    }
    lines.push(line('Total gastos', '', row.expensesTotal));
    lines.push(line('Neto', '', row.net));
  }
  return csvDocument(lines);
}
