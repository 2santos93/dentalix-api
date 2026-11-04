import type { RegionalFormat } from '../../../../shared/format/regional-format';
import type { DocumentRegionalDto } from '../../../../shared/locations/document-regional.dto';
import type { PaymentMethod, TreatmentPlanStatus } from '@prisma/client';

export const PATIENT_CREDIT_REPOSITORY = Symbol('PATIENT_CREDIT_REPOSITORY');

/** Reloj inyectado (DX-462): el día civil del tope diario sale de aquí. */
export const PATIENT_CREDIT_CLOCK = Symbol('PATIENT_CREDIT_CLOCK');
export type PatientCreditClock = () => Date;

/** Lo que el saldo a favor necesita de un plan (sumas en su moneda). */
export interface PlanCreditState {
  planId: string;
  patientId: string;
  status: TreatmentPlanStatus;
  currency: string;
  /** 0 si el plan no se cobra (cancelado o rechazado). */
  billableCents: number;
  paidCents: number;
  entriesCents: number;
  creditCents: number;
  /**
   * DX-472-bis: abonos vivos en otra moneda aún sin base (sin tasa congelada
   * todavía): no cuentan en `paidCents` hasta que el barrido la cree.
   */
  pendingOtherCurrencyPayments?: number;
}

export interface CreditTransferRecord {
  id: string;
  patientId: string;
  locationId: string;
  sourcePlanId: string;
  targetPlanId: string;
  currency: string;
  amount: number;
  reason: string | null;
  createdById: string;
  createdAt: Date;
  idempotencyFingerprint: string | null;
}

/** Foto inmutable del comprobante de devolución. */
export interface RefundReceiptSnapshot {
  number: string;
  issuedAt: string;
  clinic: { name: string };
  /** `timeZone`: IANA de la sede (DX-378), para fechas y horas impresas. */
  location: {
    id: string;
    name: string;
    address: string | null;
    timeZone: string;
  };
  patient: {
    id: string;
    fullName: string;
    documentType: string;
    docTypeLabel: string | null;
    docNumber: string | null;
  };
  plan: { id: string; label: string | null; createdAt: string };
  amount: number;
  currency: string;
  method: PaymentMethod;
  reason: string;
  payments: {
    id: string;
    paidAt: string;
    amount: number;
    currency: string;
    receiptNumber: string;
  }[];
  creditBefore: number;
  creditAfter: number;
  refundedBy: { id: string; fullName: string | null };
  cashSessionId: string | null;
}

export interface CreditRefundRecord {
  id: string;
  number: string;
  patientId: string;
  locationId: string;
  treatmentPlanId: string;
  currency: string;
  amount: number;
  method: PaymentMethod;
  reason: string;
  cashSessionId: string | null;
  paymentIds: string[];
  createdById: string;
  createdAt: Date;
  snapshot: RefundReceiptSnapshot;
  /** DX-354: región de la sede del comprobante; `null` si le falta algo. */
  regional: DocumentRegionalDto | null;
  idempotencyFingerprint: string | null;
}

export interface CreateTransferInput {
  sourcePlanId: string;
  targetPlanId: string;
  amountCents: number;
  currency: string;
  reason: string | null;
  userId: string;
  idempotencyKey?: string;
  fingerprint: string;
}

export interface CreateRefundInput {
  planId: string;
  amountCents: number;
  currency: string;
  method: PaymentMethod;
  reason: string;
  paymentIds: string[];
  userId: string;
  idempotencyKey?: string;
  fingerprint: string;
  /**
   * DX-462: solo para RECEPTION. Dentro del bloqueo por (clínica, sede,
   * usuario, día de la sede) se suman sus devoluciones del día en esta moneda;
   * si con esta pasan de `capCents` se lanza `DailyRefundCapExceededError`.
   */
  dailyCap?: { capCents: number; now: Date };
}

export interface PatientCreditMovements {
  transfers: CreditTransferRecord[];
  refunds: CreditRefundRecord[];
}

export interface PatientCreditRepository {
  readPlanCredit(planId: string): Promise<PlanCreditState | null>;
  receptionCapCents(): Promise<number>;
  /**
   * Formato de la sede de referencia (la activa o, sin ella, la principal, R6)
   * para pintar el tope de RECEPCIÓN. Perezoso: 409 `LOCATION_LOCALE_REQUIRED`
   * si no tiene locale o reloj.
   */
  referenceLocationFormat(): Promise<RegionalFormat>;
  updateReceptionCap(cents: number): Promise<number>;
  findTransferByKey(key: string): Promise<CreditTransferRecord | null>;
  findRefundByKey(key: string): Promise<CreditRefundRecord | null>;
  /**
   * En UNA transacción: bloquea los dos planes (orden por id), recalcula el
   * saldo a favor del origen y guarda el traspaso y sus dos asientos. 409
   * (`CREDIT_CHANGED_MESSAGE`) si el saldo ya no alcanza o si el origen o el
   * destino ya no están en `input.currency` (DX-438).
   */
  createTransfer(input: CreateTransferInput): Promise<CreditTransferRecord>;
  /**
   * En UNA transacción: bloquea el plan, recalcula (409 si el saldo no
   * alcanza o el plan ya no está en `input.currency`), valida los abonos de
   * referencia (400), asigna la caja (efectivo; 409 si se exige y no hay),
   * numera el comprobante y guarda la devolución con su asiento.
   */
  createRefund(input: CreateRefundInput): Promise<CreditRefundRecord>;
  getRefund(id: string): Promise<CreditRefundRecord | null>;
  listByPatient(patientId: string): Promise<PatientCreditMovements | null>;
}
