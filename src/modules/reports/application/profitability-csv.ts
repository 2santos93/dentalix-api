import { csvAmount, csvDocument, csvText } from '../../../shared/csv/csv-cells';
import type { ProfitabilityRowView } from '../domain/profitability';
import type { ProfitabilityReport } from './use-cases/get-profitability.use-case';

/*
 * CSV de «Rentabilidad por sede» (DX-410), con los mismos filtros y la MISMA
 * definición que la pantalla (la base va en cada línea). Formato largo: por
 * sede (y el «Total del grupo» al final) y moneda, una línea de ingresos, una
 * por categoría de gasto, el total de gastos, el resultado y el margen; así
 * una hoja de cálculo lo filtra sin deshacer columnas por moneda. Una sede
 * sin movimientos sale en una línea «Sin movimientos». UTF-8 con BOM, CRLF y
 * celdas de texto protegidas contra fórmulas (`csvText`); importes con los
 * decimales de la pantalla (`csvAmount`). Sin datos de pacientes.
 */
export const PROFITABILITY_CSV_HEADER = [
  'Período',
  'Base',
  'Sede',
  'Moneda',
  'Concepto',
  'Categoría',
  'Importe',
  'Movimientos',
] as const;

export const PROFITABILITY_CSV_CONCEPTS = {
  expensesTotal: 'Total gastos',
  net: 'Resultado',
  margin: 'Margen (%)',
  noActivity: 'Sin movimientos',
} as const;

export function toProfitabilityCsv(report: ProfitabilityReport): string {
  const def = report.definition;
  const period = csvText(`${report.from} a ${report.to}`);
  const basis = csvText(def.label);
  const c = PROFITABILITY_CSV_CONCEPTS;
  const lines: string[] = [PROFITABILITY_CSV_HEADER.join(',')];
  const line = (
    row: ProfitabilityRowView,
    currency: string,
    concept: string,
    category: string,
    amount: string,
    count: number | null,
  ) =>
    lines.push(
      [
        period,
        basis,
        csvText(row.name),
        csvText(currency),
        csvText(concept),
        csvText(category),
        amount,
        count === null ? '' : String(count),
      ].join(','),
    );
  for (const row of [...report.locations, report.total]) {
    if (row.currencies.length === 0) {
      line(row, '', c.noActivity, '', '', null);
      continue;
    }
    for (const m of row.currencies) {
      const money = (value: number) => csvAmount(value, m.currency);
      line(
        row,
        m.currency,
        def.incomeLabel,
        '',
        money(m.income),
        m.incomeCount,
      );
      for (const cat of m.categories) {
        line(
          row,
          m.currency,
          def.expensesLabel,
          cat.category,
          money(cat.amount),
          cat.count,
        );
      }
      line(
        row,
        m.currency,
        c.expensesTotal,
        '',
        money(m.expenses),
        m.expenseCount,
      );
      line(row, m.currency, c.net, '', money(m.net), null);
      line(
        row,
        m.currency,
        c.margin,
        '',
        m.margin === null ? '' : m.margin.toFixed(1),
        null,
      );
    }
  }
  return csvDocument(lines);
}
