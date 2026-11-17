import type { PaymentMethod, Prisma } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { SettlementPeriod } from '../commission-calculator';
import type { PayableLine } from '../settlement-payments';
import type { CommissionReceiptContent } from '../commission-receipt';
import type { CommissionPaymentView } from '../views';

export const COMMISSION_PAYMENT_REPOSITORY = Symbol(
  'COMMISSION_PAYMENT_REPOSITORY',
);

/** La transacción del alta o la anulación del gasto (DX-464, `ExpenseTxHook`). */
export type CommissionTx = Prisma.TransactionClient;

/** La cabecera de una liquidación, para pagarla y para sus documentos. */
export interface SettlementHeader {
  id: string;
  userId: string;
  membershipId: string;
  professionalName: string;
  professionalEmail: string | null;
  period: SettlementPeriod;
}

/** Lo justo de un pago para anularlo o pedir su conformidad. */
export interface PaymentRecord {
  id: string;
  settlementId: string;
  expenseId: string;
  locationId: string;
  currency: string;
  amount: number;
  paidOn: string;
  voided: boolean;
}

export interface NewCommissionPayment {
  settlementId: string;
  userId: string;
  locationId: string;
  currency: string;
  amount: number;
  method: PaymentMethod;
  paidOn: string;
  reference: string | null;
  expenseId: string;
  lineIds: readonly string[];
  createdById: string;
}

/** Una línea tal como sale en un documento que se va de la clínica. */
export interface DocumentLine {
  id: string;
  kind: 'ACCRUAL' | 'ADJUSTMENT';
  /** Solo iniciales (nunca el nombre completo). */
  patientInitials: string;
  catalogCode: string;
  catalogLabel: string;
  toothNumber: string;
  /** Día en que se liberó (o se realizó), en la zona de su sede. */
  day: string | null;
  currency: string;
  base: number;
  percent: number;
  amount: number;
  /** Pago vivo que la cubre, si lo hay. */
  paymentId: string | null;
}

/** Formato de una sede para los documentos (null: sin barrer). */
export interface DocumentFormat {
  /** La sede principal de la clínica (la de los documentos). */
  id: string;
  locale: string | null;
  hourCycle: string | null;
  timeZone: string | null;
}

export interface SettlementDocumentSource {
  clinicName: string;
  header: SettlementHeader;
  closedAt: Date;
  basis: 'COLLECTED' | 'PRODUCED';
  lines: DocumentLine[];
  payments: CommissionPaymentView[];
  format: DocumentFormat;
}

/** Un enlace de conformidad tal como lo ve la ruta pública. */
export interface ReceiptRequestRecord {
  id: string;
  paymentId: string;
  content: CommissionReceiptContent;
  contentHash: string;
  expiresAt: Date;
  openedAt: Date | null;
  signedAt: Date | null;
  signerName: string | null;
  signature: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  receiptHash: string | null;
  revokedAt: Date | null;
  /** El pago está anulado: el enlace ya no vale. */
  paymentVoided: boolean;
}

export interface ReceiptEvidence {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CommissionPaymentRepository {
  header(settlementId: string): Promise<SettlementHeader | null>;
  /** Líneas de la liquidación con su pago vivo (fuera de transacción). */
  payableLines(settlementId: string): Promise<PayableLine[]>;
  payments(settlementId: string): Promise<CommissionPaymentView[]>;
  findPayment(paymentId: string): Promise<PaymentRecord | null>;

  // --- Dentro de la transacción del gasto (ExpenseTxHook) -------------------
  /** Un pago o anulación a la vez por liquidación (advisory lock). */
  lockSettlement(tx: CommissionTx, settlementId: string): Promise<void>;
  payableLinesIn(
    tx: CommissionTx,
    settlementId: string,
  ): Promise<PayableLine[]>;
  /** 409 `PERIOD_LOCKED` si el día cae en un período contable cerrado. */
  assertDayOpen(
    tx: CommissionTx,
    day: string,
    locationId: string,
    operation: 'PAYMENT_CREATE' | 'PAYMENT_VOID',
    message: string,
  ): Promise<void>;
  insertPayment(
    tx: CommissionTx,
    payment: NewCommissionPayment,
    ctx: AuditRequestContext,
  ): Promise<string>;
  /** Anula el pago y sus líneas y revoca su enlace vivo. false si ya estaba anulado. */
  voidPayment(
    tx: CommissionTx,
    payment: PaymentRecord,
    reason: string,
    ctx: AuditRequestContext,
  ): Promise<boolean>;

  // --- Documentos y conformidad --------------------------------------------
  settlementDocument(
    settlementId: string,
  ): Promise<SettlementDocumentSource | null>;
  /** Revoca el enlace vivo del pago, crea el nuevo y lo audita. */
  createReceiptRequest(
    input: {
      paymentId: string;
      tokenHash: string;
      content: CommissionReceiptContent;
      contentHash: string;
      expiresAt: Date;
    },
    ctx: AuditRequestContext,
  ): Promise<void>;
  /** El firmado de un pago, si lo hay. */
  signedReceipt(paymentId: string): Promise<ReceiptRequestRecord | null>;
  /** Ruta pública: por hash del token, bajo el tenant del host. */
  receiptByToken(tokenHash: string): Promise<ReceiptRequestRecord | null>;
  markReceiptOpened(id: string): Promise<void>;
  /** Firma una vez (false si otra petición se adelantó o ya no vale). */
  signReceipt(
    id: string,
    input: {
      signerName: string;
      signature: string;
      receiptHash: string;
      evidence: ReceiptEvidence;
      now: Date;
    },
  ): Promise<boolean>;
}
