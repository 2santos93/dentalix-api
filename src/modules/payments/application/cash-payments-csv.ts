import { csvAmount, csvDocument, csvText } from '../../../shared/csv/csv-cells';
import { currencyDecimals } from '../../../shared/money/currency-decimals';
import type { CashPaymentView } from '../domain/entities/cash-payment.entity';

/*
 * CSV de la caja (DX-395): una línea por abono con los mismos filtros que la
 * pantalla (período, sede, método y medio). Lleva el medio de pago de la
 * clínica y la referencia del pago, que solo descargan los roles de cobro.
 * Texto libre entre comillas, sin saltos de línea y protegido contra
 * fórmulas; importes con los decimales de su moneda. Las notas del abono no
 * viajan: son internas y la caja no las muestra.
 */
export const CASH_PAYMENTS_CSV_HEADER = [
  'Fecha',
  'Sede',
  'Paciente',
  'Destino',
  'Medio',
  'Referencia',
  'Moneda',
  'Importe',
] as const;

const NO_METHOD = 'Sin método';

/** Mismo nombre que la pantalla: «Plan del <día>» o «Saldo migrado · …». */
function destinationOf(row: CashPaymentView): string {
  if (row.treatmentPlan) {
    return `Plan del ${row.treatmentPlan.createdAt.toISOString().slice(0, 10)}`;
  }
  return row.openingBalance?.concept
    ? `Saldo migrado · ${row.openingBalance.concept}`
    : 'Saldo migrado';
}

export function toCashPaymentsCsv(rows: readonly CashPaymentView[]): string {
  const lines: string[] = [CASH_PAYMENTS_CSV_HEADER.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.paidOn,
        csvText(row.location.name),
        csvText(row.patient.fullName),
        csvText(destinationOf(row)),
        csvText(row.paymentMethod?.name ?? NO_METHOD),
        csvText(row.reference),
        row.currency,
        csvAmount(row.amount, currencyDecimals(row.currency)),
      ].join(','),
    );
  }
  return csvDocument(lines);
}
