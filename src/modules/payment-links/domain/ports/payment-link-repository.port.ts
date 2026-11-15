import type {
  ContactChannel,
  PaymentProofPolicy,
  PaymentReportStatus,
  Prisma,
  TreatmentPlanStatus,
} from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { DocumentRegionalDto } from '../../../../shared/locations/document-regional.dto';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import type { PaymentProofAttachment } from '../../../payments/domain/payment-proof';
import type { PaymentInstructionFields } from '../../../payment-methods/domain/payment-method-instructions';
import type { PaymentLinkChannel, PaymentLinkConcept } from '../payment-link';

export const PAYMENT_LINK_REPOSITORY = Symbol('PAYMENT_LINK_REPOSITORY');

/** El paciente al que se le crea un enlace (bajo RLS, vivo). */
export interface PaymentLinkPatient {
  id: string;
  firstName: string;
  email: string | null;
  phone: string | null;
  contactChannel: ContactChannel;
  reminderOptOutAt: Date | null;
}

export interface PaymentLinkPlanTarget {
  id: string;
  status: TreatmentPlanStatus;
  currency: string;
  /** La sede del plan (aceptado o presentado); null si no tiene. */
  locationId: string | null;
  /** Tiene un plan de pagos ACTIVO: el concepto es «Cuota». */
  hasActivePaymentPlan: boolean;
}

export interface PaymentLinkBalanceTarget {
  id: string;
  currency: string;
  locationId: string;
}

export interface IssuePaymentLinkInput {
  id: string;
  patientId: string;
  treatmentPlanId: string | null;
  openingBalanceId: string | null;
  /** La sede del enlace (`linkLocation`). */
  locationId: string;
  amount: number;
  currency: string;
  concept: PaymentLinkConcept;
  tokenHash: string;
  expiresAt: Date;
  channel: PaymentLinkChannel | null;
  createdById: string;
  now: Date;
  /** DX-463: el email del enlace, en la MISMA transacción. */
  enqueue?: (tx: Prisma.TransactionClient) => Promise<void>;
}

export interface IssuedPaymentLink {
  id: string;
  /** Enlaces anteriores del mismo destino que esta creación anuló. */
  revoked: number;
}

/** La sede del enlace, con lo que hace falta para el mensaje. */
export interface PaymentLinkLocation {
  id: string;
  timeZone: string | null;
  locale: string | null;
  hourCycle: string | null;
  /** Región por defecto de los teléfonos de la sede (WhatsApp). */
  defaultPhoneRegion: string | null;
}

/** Un enlace en la ficha del paciente (sin token: no se guarda). */
export interface PatientPaymentLinkRow {
  id: string;
  treatmentPlanId: string | null;
  openingBalanceId: string | null;
  locationId: string;
  amount: number;
  currency: string;
  concept: PaymentLinkConcept;
  channel: PaymentLinkChannel | null;
  expiresAt: Date;
  createdAt: Date;
  createdById: string;
  openedAt: Date | null;
  usedAt: Date | null;
  revokedAt: Date | null;
  report: { id: string; status: PaymentReportStatus } | null;
}

/** El enlace tal como lo lee una ruta pública (bajo la RLS del host). */
export interface PublicPaymentLinkRow {
  id: string;
  patientId: string;
  patientFirstName: string;
  treatmentPlanId: string | null;
  openingBalanceId: string | null;
  locationId: string;
  locationTimeZone: string | null;
  /** DX-354: zona, locale y reloj de la sede del enlace; null si le falta algo. */
  regional: DocumentRegionalDto | null;
  amount: number;
  currency: string;
  concept: PaymentLinkConcept;
  expiresAt: Date;
  createdAt: Date;
  openedAt: Date | null;
  usedAt: Date | null;
  revokedAt: Date | null;
  proofUploadsIssued: number;
  stagedProof: PaymentProofAttachment | null;
}

/** Un medio que el enlace puede ofrecer, con los datos de cada ámbito. */
export interface LinkMethodRow {
  id: string;
  name: string;
  active: boolean;
  allowInPaymentLink: boolean;
  requiresReference: boolean;
  proofPolicy: PaymentProofPolicy;
}

export interface LinkInstructionRow extends PaymentInstructionFields {
  paymentMethodId: string;
  locationId: string | null;
}

export interface ClinicBrandingRow {
  name: string;
  primaryColor: string;
  logoUrl: string | null;
}

export interface SubmitReportInput {
  id: string;
  linkId: string;
  paymentMethodId: string;
  amount: number;
  currency: string;
  reference: string | null;
  paidOn: string;
  note: string | null;
  proof: PaymentProofAttachment | null;
  now: Date;
  meta: AuditRequestMeta;
}

export type SubmitReportOutcome =
  | { kind: 'CREATED'; reportId: string }
  | { kind: 'USED' }
  | { kind: 'GONE' }
  /** Otra subida sustituyó el comprobante preparado mientras tanto. */
  | { kind: 'PROOF_CHANGED' };

/** Un reporte en la bandeja «Pagos por confirmar». */
export interface PaymentReportRow {
  id: string;
  status: PaymentReportStatus;
  createdAt: Date;
  patientId: string;
  patientName: string;
  locationId: string;
  paymentMethodId: string;
  paymentMethodName: string;
  amount: number;
  currency: string;
  reference: string | null;
  paidOn: string;
  note: string | null;
  proof: PaymentProofAttachment | null;
  paymentId: string | null;
  rejectReason: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
  link: {
    id: string;
    treatmentPlanId: string | null;
    openingBalanceId: string | null;
    amount: number;
    currency: string;
    concept: PaymentLinkConcept;
    createdAt: Date;
  };
}

export interface ReportListQuery {
  status: PaymentReportStatus | null;
  /** undefined = sin restricción de sede. */
  locationIds: string[] | undefined;
  page: number;
  pageSize: number;
}

export type RejectReportOutcome =
  | { kind: 'REJECTED'; report: PaymentReportRow }
  | { kind: 'NOT_FOUND' }
  | { kind: 'NOT_PENDING' };

/** Enlaces de pago y reportes (DX-569), todo bajo `runWithTenant` (RLS). */
export interface PaymentLinkRepository {
  // --- crear el enlace (ficha del paciente) ---
  findPatient(patientId: string): Promise<PaymentLinkPatient | null>;
  findPlanTarget(
    patientId: string,
    planId: string,
  ): Promise<PaymentLinkPlanTarget | null>;
  findBalanceTarget(
    patientId: string,
    balanceId: string,
  ): Promise<PaymentLinkBalanceTarget | null>;
  clinicName(): Promise<string>;
  /**
   * La sede del enlace: la del destino si la tiene; si no, la sede de
   * escritura de quien lo crea (la de la cabecera o la primera permitida).
   */
  linkLocation(locationId: string | null): Promise<PaymentLinkLocation>;
  /**
   * Paciente vivo bajo candado (409 si se archivó), el anterior del mismo
   * destino anulado y el nuevo creado, y el email (si lo hay), en UNA
   * transacción.
   */
  issueLink(input: IssuePaymentLinkInput): Promise<IssuedPaymentLink>;
  listForPatient(patientId: string): Promise<PatientPaymentLinkRow[] | null>;

  // --- rutas públicas ---
  findByTokenHash(tokenHash: string): Promise<PublicPaymentLinkRow | null>;
  clinicBranding(): Promise<ClinicBrandingRow | null>;
  linkMethods(): Promise<{
    methods: LinkMethodRow[];
    instructions: LinkInstructionRow[];
  }>;
  /** Monedas de las sedes vivas de la clínica (las que cobra). */
  clinicCurrencies(): Promise<string[]>;
  markOpened(linkId: string, now: Date): Promise<void>;
  /** Gasta una de las autorizaciones de subida; `false` si no quedan o no está vivo. */
  reserveProofUpload(linkId: string, now: Date): Promise<boolean>;
  /**
   * Deja el comprobante completado como el preparado del enlace (vivo).
   * Devuelve la clave del que sustituye (para borrarla) o `undefined` si el
   * enlace ya no está vivo.
   */
  stageProof(
    linkId: string,
    proof: PaymentProofAttachment,
    now: Date,
  ): Promise<{ replacedKey: string | null } | undefined>;
  submitReport(input: SubmitReportInput): Promise<SubmitReportOutcome>;

  // --- bandeja ---
  listReports(
    query: ReportListQuery,
  ): Promise<{ items: PaymentReportRow[]; total: number }>;
  countReports(
    status: PaymentReportStatus,
    locationIds: string[] | undefined,
  ): Promise<number>;
  findReport(id: string): Promise<PaymentReportRow | null>;
  /**
   * Dentro de la transacción del abono: el reporte pendiente pasa a
   * CONFIRMED con el abono (condicional; `false` si ya no estaba pendiente).
   */
  confirmInTx(
    tx: Prisma.TransactionClient,
    input: {
      reportId: string;
      paymentId: string;
      decidedById: string;
      now: Date;
    },
  ): Promise<boolean>;
  rejectReport(input: {
    reportId: string;
    reason: string;
    now: Date;
    audit: AuditRequestContext;
  }): Promise<RejectReportOutcome>;
  /** El email del paciente del reporte, si lo tiene (aviso del rechazo). */
  patientContact(
    patientId: string,
  ): Promise<{ firstName: string; email: string | null } | null>;
}
