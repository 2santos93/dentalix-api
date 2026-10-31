import {
  UNCATEGORIZED_LABEL,
  type AmountTotals,
} from '../domain/production-by-procedure';
import type { ProductionByProcedure } from './use-cases/get-production-by-procedure.use-case';
import { ISO_ZERO_DECIMAL_CURRENCIES } from '../../../shared/money/currency-decimals';

/*
 * CSV de «Producción por procedimiento» (DX-423): las MISMAS filas y en el
 * mismo orden que la pantalla (cada categoría con sus procedimientos y su
 * subtotal por moneda, los totales por moneda y los «Sin atribuir»), con el
 * período y los filtros en la cabecera. Sin nombres de paciente. Mismo
 * formato que los demás reportes (DX-014, DX-204): UTF-8 con BOM, CRLF, texto
 * entre comillas y las celdas que empiezan por = + - @ (o tabulador/CR)
 * prefijadas con «'» para que la hoja no las ejecute como fórmula (el código
 * y el nombre del procedimiento los escribe la clínica).
 */
export const PRODUCTION_CSV_COLUMNS = [
  'Fila',
  'Categoría',
  'Código',
  'Procedimiento',
  'Moneda',
  'Cantidad',
  'Bruto',
  'Descuentos',
  'Neto',
  'Honorario medio',
  'Medio de catálogo',
  'Diferencia %',
] as const;

export const PRODUCTION_CSV_TITLE = 'Producción por procedimiento';

const FORMULA_START = /^[\s]*[=+\-@]|^[\t\r]/;

function text(value: string): string {
  const raw = value.replace(/[\r\n]+/g, ' ');
  const safe = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

function num(value: number | null, decimals: number): string {
  return value === null ? '' : value.toFixed(decimals);
}

/**
 * Un importe con los decimales que pinta la pantalla (`moneyWithCode` de la
 * web): 0 en una moneda sin unidad menor (ISO 4217) si el importe es entero;
 * si no, 2.
 */
function money(value: number | null, currency: string): string {
  if (value === null) return '';
  const zero =
    ISO_ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) &&
    Number.isInteger(value);
  return value.toFixed(zero ? 0 : 2);
}

const categoryName = (category: string | null) =>
  category ?? UNCATEGORIZED_LABEL;

function amounts(t: AmountTotals, average: boolean): string[] {
  return [
    text(t.currency),
    String(t.count),
    money(t.gross, t.currency),
    money(t.discounts, t.currency),
    money(t.net, t.currency),
    average ? money(t.averageNet, t.currency) : '',
  ];
}

function professionalLine(report: ProductionByProcedure): string {
  const name = report.filters.professionalName;
  if (report.scope === 'OWN') {
    return name ? `Solo tu producción (${name})` : 'Solo tu producción';
  }
  if (report.filters.professionalId === null) return 'Todo el equipo';
  return name ?? 'Profesional sin datos en esta clínica';
}

export function toProductionByProcedureCsv(
  report: ProductionByProcedure,
): string {
  const header = [
    [text(PRODUCTION_CSV_TITLE)],
    [text('Período'), text(`${report.from} a ${report.to}`)],
    [text('Sede'), text(report.filters.locationName ?? 'Todas tus sedes')],
    [text('Profesional'), text(professionalLine(report))],
    [text('Categoría'), text(report.filters.category ?? 'Todas')],
    [text('Importes'), text('Por moneda, sin convertir')],
    [],
    PRODUCTION_CSV_COLUMNS.map(text),
  ];
  const body: string[][] = [];
  const categories = [
    ...new Set(report.categoryTotals.map((c) => JSON.stringify(c.category))),
  ].map((k) => JSON.parse(k) as string | null);
  for (const category of categories) {
    for (const row of report.rows.filter((r) => r.category === category)) {
      body.push([
        text('Procedimiento'),
        text(categoryName(category)),
        text(row.code),
        text(row.label),
        ...amounts(row, true),
        money(row.catalogAverage, row.currency),
        num(row.differencePercent, 1),
      ]);
    }
    for (const sub of report.categoryTotals.filter(
      (c) => c.category === category,
    )) {
      body.push([
        text('Subtotal'),
        text(categoryName(category)),
        text(''),
        text(''),
        ...amounts(sub, true),
        '',
        '',
      ]);
    }
  }
  for (const total of report.totals) {
    body.push([
      text('Total'),
      text(''),
      text(''),
      text(''),
      ...amounts(total, true),
      '',
      '',
    ]);
  }
  for (const pending of report.unattributed) {
    body.push([
      text('Sin atribuir'),
      text(''),
      text(''),
      text(''),
      ...amounts({ ...pending, averageNet: 0 }, false),
      '',
      '',
    ]);
  }
  // Sin fecha: fuera de cualquier período; la pantalla lo avisa bajo la tabla.
  for (const undated of report.undated) {
    body.push([
      text('Sin fecha (fuera del período)'),
      text(''),
      text(''),
      text(''),
      ...amounts({ ...undated, averageNet: 0 }, false),
      '',
      '',
    ]);
  }
  const lines = [...header, ...body].map((cells) => cells.join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
