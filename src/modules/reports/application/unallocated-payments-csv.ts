import type { UnallocatedPayments } from './use-cases/get-unallocated-payments.use-case';
import { CLDR_ZERO_FORMAT_DIGITS } from '../../../shared/format/cldr-format-digits';
import { amountText } from '../../../shared/money/money';

/*
 * CSV de «Cobrado sin imputar / a cuenta» (DX-399): las MISMAS filas que la
 * pantalla, todas (sin paginar), con el período y la sede en la cabecera y
 * los totales por moneda del plan al final. Mismo formato que los demás
 * reportes (DX-014, DX-204, DX-423): UTF-8 con BOM, CRLF, texto entre
 * comillas y las celdas que empiezan por = + - @ (o tabulador/CR) prefijadas
 * con «'» para que la hoja no las ejecute como fórmula (el nombre del
 * paciente y el de la sede los escribe la clínica). Importes sin símbolo ni
 * separador de miles, con su código ISO en la columna de al lado.
 */
export const UNALLOCATED_CSV_TITLE = 'Cobrado sin imputar / a cuenta';

export const UNALLOCATED_CSV_COLUMNS = [
  'Fila',
  'Paciente',
  'Sede',
  'Fecha del abono',
  'Moneda del abono',
  'Importe del abono',
  'Moneda del plan',
  'Imputado',
  'Sin imputar',
] as const;

const FORMULA_START = /^[\s]*[=+\-@]|^[\t\r]/;

function text(value: string): string {
  const raw = value.replace(/[\r\n]+/g, ' ');
  const safe = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Los decimales de la pantalla: 0 en una moneda sin unidad menor si es entero. */
function money(value: number, currency: string): string {
  const zero =
    CLDR_ZERO_FORMAT_DIGITS.has(currency.toUpperCase()) &&
    Number.isInteger(value);
  return amountText(value, zero ? 0 : 2);
}

export function toUnallocatedPaymentsCsv(report: UnallocatedPayments): string {
  const header = [
    [text(UNALLOCATED_CSV_TITLE)],
    [text('Período'), text(`${report.from} a ${report.to}`)],
    [text('Sede'), text(report.filters.locationName ?? 'Todas tus sedes')],
    [
      text('Importes'),
      text(
        'Imputado y sin imputar en la moneda del plan (el abono convertido con la tasa de su día); los totales no mezclan monedas',
      ),
    ],
    [
      text('Sin imputar'),
      text('Neto de lo ya devuelto o traspasado del saldo a favor (DX-253)'),
    ],
    [],
    UNALLOCATED_CSV_COLUMNS.map(text),
  ];
  const body: string[][] = report.items.map((i) => [
    text('Abono'),
    text(i.patient.fullName),
    text(i.location.name),
    text(i.paidOn),
    text(i.paymentCurrency),
    money(i.paymentAmount, i.paymentCurrency),
    text(i.planCurrency),
    money(i.allocated, i.planCurrency),
    money(i.unallocated, i.planCurrency),
  ]);
  for (const t of report.totals) {
    body.push([
      text('Total'),
      text(`${t.count} ${t.count === 1 ? 'abono' : 'abonos'}`),
      text(''),
      text(''),
      text(''),
      '',
      text(t.currency),
      money(t.allocated, t.currency),
      money(t.unallocated, t.currency),
    ]);
  }
  const lines = [...header, ...body].map((cells) => cells.join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
