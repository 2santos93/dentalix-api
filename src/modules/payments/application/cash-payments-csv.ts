import { csvAmount, csvDocument, csvText } from '../../../shared/csv/csv-cells';
import type { CurrencyDigitsTable } from '../../../shared/money/currency-digits';
import type { RoundingDigits } from '../../../shared/money/line-rounding';
import { fromCents, toCents } from '../../../shared/money/money';
import type { PaymentAdjustmentType } from '@prisma/client';
import type { CashPaymentView } from '../domain/entities/cash-payment.entity';

/*
 * CSV de la caja (DX-395): una línea por abono con los mismos filtros que la
 * pantalla (período, sede, método, medio y, DX-515, con o sin factura
 * externa). Lleva el medio de pago de la clínica, la referencia del pago y el
 * nº de la factura fiscal externa, que solo descargan los roles de cobro.
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
  // DX-515: nº de la factura fiscal emitida fuera (vacío si no se anotó).
  'Factura externa',
  'Moneda',
  'Importe',
  // DX-516: ajustes por medio de pago (al final: la cabecera anterior no se
  // mueve). Vacíos sin ajustes; «Total cobrado» es entonces el importe.
  'Impuestos',
  'Recargos',
  'Descuentos',
  'Total cobrado',
  'Detalle de ajustes',
] as const;

const NO_METHOD = 'Sin método';

/** DX-516: la suma de un tipo de ajuste del abono, o vacío si no tiene. */
function adjustmentCell(
  row: CashPaymentView,
  type: PaymentAdjustmentType,
  digits: RoundingDigits,
): string {
  const lines = row.adjustments.filter((a) => a.type === type);
  if (lines.length === 0) return '';
  const cents = lines.reduce((sum, a) => sum + toCents(a.amount), 0);
  return csvAmount(fromCents(cents), digits);
}

/** DX-516: «Etiqueta +3.00; Otra −2.50», con los decimales de su moneda. */
function adjustmentDetail(
  row: CashPaymentView,
  digits: RoundingDigits,
): string {
  return row.adjustments
    .map(
      (a) =>
        `${a.label} ${a.type === 'DISCOUNT' ? '-' : '+'}${csvAmount(a.amount, digits)}`,
    )
    .join('; ');
}

/** Mismo nombre que la pantalla: «Plan del <día>» o «Saldo migrado · …». */
function destinationOf(row: CashPaymentView): string {
  if (row.treatmentPlan) {
    return `Plan del ${row.treatmentPlan.createdAt.toISOString().slice(0, 10)}`;
  }
  return row.openingBalance?.concept
    ? `Saldo migrado · ${row.openingBalance.concept}`
    : 'Saldo migrado';
}

export function toCashPaymentsCsv(
  rows: readonly CashPaymentView[],
  digits: CurrencyDigitsTable,
): string {
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
        csvText(row.externalInvoiceNumber),
        row.currency,
        csvAmount(row.amount, digits.roundingDigits(row.currency)),
        adjustmentCell(row, 'TAX', digits.roundingDigits(row.currency)),
        adjustmentCell(row, 'SURCHARGE', digits.roundingDigits(row.currency)),
        adjustmentCell(row, 'DISCOUNT', digits.roundingDigits(row.currency)),
        csvAmount(row.collectedAmount, digits.roundingDigits(row.currency)),
        csvText(adjustmentDetail(row, digits.roundingDigits(row.currency))),
      ].join(','),
    );
  }
  return csvDocument(lines);
}
