import type {
  ReceiptSnapshot,
  ReceiptSnapshotInput,
} from '../receipt-snapshot';

export const PAYMENT_RECEIPT_REPOSITORY = Symbol('PAYMENT_RECEIPT_REPOSITORY');

/** Recibo numerado tal como se emitió (DX-136). */
export interface IssuedPaymentReceipt {
  seriesPrefix: string;
  number: number;
  issuedAt: Date;
  snapshot: ReceiptSnapshot;
  voidedAt: Date | null;
  voidReason: string | null;
}

/**
 * Abono anterior a la numeración: sin recibo guardado. Sus datos se leen tal
 * como están hoy (no hay foto) y el saldo lo calcula el caso de uso.
 */
export interface LegacyReceiptSource {
  /** Alta del abono: lo más parecido a la emisión que se conserva. */
  issuedAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
  snapshotInput: Omit<ReceiptSnapshotInput, 'planBalance'>;
}

interface ReceiptSourceBase {
  paymentId: string;
  treatmentPlanId: string;
  /** Email ACTUAL del paciente (para enviarle el recibo), o null si no tiene. */
  patientEmail: string | null;
}

export type PaymentReceiptSource =
  | (ReceiptSourceBase & { kind: 'issued'; receipt: IssuedPaymentReceipt })
  | (ReceiptSourceBase & { kind: 'legacy'; legacy: LegacyReceiptSource });

export interface PaymentReceiptRepository {
  /**
   * El recibo del abono (anulado o no) de la clínica del contexto (RLS), o
   * los datos para mostrar el de un abono anterior a la numeración. `null`
   * si el abono no existe o es de otra clínica.
   */
  findByPaymentId(paymentId: string): Promise<PaymentReceiptSource | null>;
}
