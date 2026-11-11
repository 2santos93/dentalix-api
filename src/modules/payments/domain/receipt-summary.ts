import type { PaymentMethod } from '@prisma/client';
import { fromCents, toCents } from '../../../shared/money/money';
import type { ReceiptClinicData } from './receipt-snapshot';

/**
 * DX-401: pie del resumen de abonos de un período. No sustituye a ningún
 * recibo: cada abono conserva su recibo de caja con su número.
 */
export const RECEIPT_SUMMARY_NOTICE =
  'Resumen de abonos: no es un documento fiscal. Cada abono tiene su recibo de caja con el número indicado.';

/** Un año, bisiesto incluido, contando ambos extremos (como la caja). */
export const RECEIPT_SUMMARY_MAX_DAYS = 366;

export const RECEIPT_SUMMARY_INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const RECEIPT_SUMMARY_PERIOD_TOO_LONG_MESSAGE = `El período del resumen admite como mucho ${RECEIPT_SUMMARY_MAX_DAYS} días.`;
export const RECEIPT_SUMMARY_EMPTY_MESSAGE = 'No hay abonos en ese periodo';

const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Efectivo',
  CARD: 'Tarjeta',
  TRANSFER: 'Transferencia',
  OTHER: 'Otro',
};

/**
 * Cómo se nombra la forma de pago en el recibo y en su email: el medio de
 * pago de la clínica (DX-377) o, sin él, el método; sin ninguno, «Sin
 * especificar».
 */
export function receiptMethodLabel(
  method: PaymentMethod | null,
  paymentMethodName: string | null | undefined,
): string {
  if (paymentMethodName?.trim()) return paymentMethodName.trim();
  return method ? METHOD_LABELS[method] : 'Sin especificar';
}

/** Una forma de pago de un recibo (un abono suelto tiene una; uno dividido, varias). */
export interface ReceiptSummaryPart {
  amount: number;
  currency: string;
  method: PaymentMethod | null;
  paymentMethodName: string | null;
}

/**
 * Un recibo del período tal como lo lee el repositorio: su número visible,
 * su emisión (instante y día civil en la zona de su sede), la sede de la foto
 * y sus formas de pago.
 */
export interface ReceiptSummarySourceItem {
  paymentId: string;
  locationId: string;
  receiptNumber: string;
  issuedAt: Date;
  issuedOn: string;
  locationName: string;
  voided: boolean;
  voidReason: string | null;
  parts: ReceiptSummaryPart[];
}

/** Una fila del resumen: una forma de pago de un recibo. */
export interface ReceiptSummaryLine {
  paymentId: string;
  receiptNumber: string;
  issuedOn: string;
  locationName: string;
  methodLabel: string;
  amount: number;
  currency: string;
  voided: boolean;
  voidReason: string | null;
}

export interface ReceiptSummaryTotal {
  currency: string;
  amount: number;
  /** Filas (formas de pago) no anuladas en esa moneda. */
  count: number;
}

export interface ReceiptSummaryPatient {
  id: string;
  fullName: string;
  /** Número del documento enmascarado como en el recibo (`******5678`), o null. */
  documentMasked: string | null;
  /** DX-327: nombre visible del tipo de documento (`Documento nacional`, `Pasaporte`…). */
  documentTypeName: string;
  patientCode: string;
}

/** La vista del resumen (pantalla, papel y email salen de aquí). */
export interface PaymentReceiptSummaryView {
  patient: ReceiptSummaryPatient;
  clinic: ReceiptClinicData;
  from: string;
  to: string;
  generatedAt: string;
  /** El miembro solo ve sus sedes: el resumen omite los recibos de las demás. */
  restrictedToLocations: boolean;
  receipts: ReceiptSummaryLine[];
  totals: ReceiptSummaryTotal[];
  voidedCount: number;
  notice: string;
}

/**
 * Las filas del resumen en orden de emisión (y, dentro de un cobro dividido,
 * en el orden de sus líneas). Cada forma de pago es su propia fila con su
 * moneda: un cobro en USD y VES nunca se suma en una sola cifra.
 */
export function receiptSummaryLines(
  items: readonly ReceiptSummarySourceItem[],
): ReceiptSummaryLine[] {
  return [...items]
    .sort(
      (a, b) =>
        a.issuedAt.getTime() - b.issuedAt.getTime() ||
        a.receiptNumber.localeCompare(b.receiptNumber),
    )
    .flatMap((item) =>
      item.parts.map((part) => ({
        paymentId: item.paymentId,
        receiptNumber: item.receiptNumber,
        issuedOn: item.issuedOn,
        locationName: item.locationName,
        methodLabel: receiptMethodLabel(part.method, part.paymentMethodName),
        amount: part.amount,
        currency: part.currency,
        voided: item.voided,
        voidReason: item.voidReason,
      })),
    );
}

/**
 * Total POR MONEDA de lo no anulado, sumado en céntimos (DX-054). Las monedas
 * nunca se mezclan; orden alfabético del código. Sin filas vivas: `[]`.
 */
export function receiptSummaryTotals(
  lines: readonly ReceiptSummaryLine[],
): ReceiptSummaryTotal[] {
  const byCurrency = new Map<string, { cents: number; count: number }>();
  for (const line of lines) {
    if (line.voided) continue;
    const acc = byCurrency.get(line.currency) ?? { cents: 0, count: 0 };
    acc.cents += toCents(line.amount);
    acc.count += 1;
    byCurrency.set(line.currency, acc);
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, acc]) => ({
      currency,
      amount: fromCents(acc.cents),
      count: acc.count,
    }));
}

/** Recibos (no filas) anulados del período. */
export function receiptSummaryVoidedCount(
  items: readonly ReceiptSummarySourceItem[],
): number {
  return items.filter((item) => item.voided).length;
}
