import type { DocumentType } from '@prisma/client';
import type { ReceiptClinicInput } from '../receipt-snapshot';
import type { ReceiptSummarySourceItem } from '../receipt-summary';
import type { ReceiptNoticeData } from './payment-receipt-repository.port';

export const PAYMENT_RECEIPT_SUMMARY_REPOSITORY = Symbol(
  'PAYMENT_RECEIPT_SUMMARY_REPOSITORY',
);

/** El paciente del resumen, con sus datos de HOY (el resumen se emite hoy). */
export interface ReceiptSummaryPatientRow {
  id: string;
  firstName: string;
  lastName: string;
  documentType: DocumentType;
  docTypeLabel: string | null;
  docNumber: string | null;
  patientCode: number;
}

export interface ReceiptSummarySource {
  patient: ReceiptSummaryPatientRow;
  /** Los datos fiscales de HOY de la clínica (los del resumen, no los de cada foto). */
  clinic: ReceiptClinicInput;
  /** Los recibos del período (anulados incluidos), en cualquier orden. */
  items: ReceiptSummarySourceItem[];
}

export interface ReceiptSummaryQuery {
  patientId: string;
  /** Días civiles, ambos inclusive, ya validados. */
  from: string;
  to: string;
  /** DX-525: solo los recibos de estas sedes; `undefined` = todas. */
  locationIds: readonly string[] | undefined;
}

/** Para enviar el resumen: el email de HOY del paciente y lo que decide si va al responsable (DX-203). */
export interface ReceiptSummaryRecipientSource {
  patientEmail: string | null;
  notice: ReceiptNoticeData;
}

export interface PaymentReceiptSummaryRepository {
  /**
   * El paciente, la clínica y los recibos de sus abonos emitidos en el
   * período, cada uno con el día civil de la zona de SU sede (DX-097), bajo la
   * RLS del contexto. `null` si el paciente no existe, está retirado o es de
   * otra clínica.
   */
  find(query: ReceiptSummaryQuery): Promise<ReceiptSummarySource | null>;

  /**
   * El destinatario del email: con la mayoría de edad de la clínica y el día
   * civil de `locationId` (la sede del último recibo del resumen).
   */
  recipient(
    patientId: string,
    locationId: string,
  ): Promise<ReceiptSummaryRecipientSource>;
}
