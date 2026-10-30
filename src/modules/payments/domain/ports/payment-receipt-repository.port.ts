import type {
  ReceiptSnapshot,
  ReceiptSnapshotInput,
} from '../receipt-snapshot';

import type { PaymentRateState } from '../payment-exchange-rate';
import type {
  NoticeSettings,
  NoticePatientFields,
  NoticeResponsible,
} from '../../../patients/domain/communication/notice-recipient';

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

/**
 * DX-203: lo que decide si el recibo va al responsable: edad (con la mayoría
 * de edad de la clínica y el día civil de la SEDE DEL ABONO) y responsables
 * vivos del paciente.
 */
export interface ReceiptNoticeData {
  patient: NoticePatientFields;
  responsibles: NoticeResponsible[];
  settings: NoticeSettings;
}

interface ReceiptSourceBase {
  paymentId: string;
  /** `null` en un abono contra un saldo migrado (DX-262). */
  treatmentPlanId: string | null;
  /** Email ACTUAL del paciente (para enviarle el recibo), o null si no tiene. */
  patientEmail: string | null;
  notice: ReceiptNoticeData;
  /**
   * DX-376: el importe del abono y su tasa tal como la guarda hoy (DX-375).
   * No va en la foto: un abono «sin tasa» la congela después, y la tasa
   * congelada ya no cambia nunca, así que reimprimir da siempre la misma.
   */
  rate: PaymentRateState & { amount: number };
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
