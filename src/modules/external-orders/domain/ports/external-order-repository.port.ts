import type { DocumentType } from '@prisma/client';
import type { ExternalOrder, ExternalOrderSnapshot } from '../external-order';
import type { ExternalOrderContent } from '../external-order-rules';

export const EXTERNAL_ORDER_REPOSITORY = Symbol('EXTERNAL_ORDER_REPOSITORY');

/** Un profesional tal como figura en la orden (membresía + usuario). */
export interface ExternalOrderProfessional {
  membershipId: string;
  name: string;
  license: string | null;
  specialty: string | null;
}

/** Todo lo que hace falta para emitir, leído en una transacción con RLS. */
export interface ExternalOrderIssueContext {
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    birthDate: Date | null;
    docType: DocumentType;
    docTypeLabel: string | null;
    docNumber: string | null;
  };
  /** La cita indicada (del paciente), o null sin cita. */
  appointment: { id: string; locationId: string } | null;
  /** La sede de la orden: la de la cita o, sin cita, la activa. */
  location: {
    id: string;
    name: string;
    address: string | null;
    healthRegistrationNumber: string | null;
    showHealthRegistrationNumber: boolean;
    timeZone: string | null;
    locale: string | null;
    hourCycle: string | null;
  };
  clinic: {
    name: string;
    legalName: string | null;
    taxIdLabel: string | null;
    taxId: string | null;
    /** La clave del logo HOY (se congela la que se puede pintar). */
    logoKey: string | null;
  };
  /** Membresía de quien emite; null si no es miembro. */
  issuer: ExternalOrderProfessional | null;
  /** La plantilla indicada, o null sin plantilla. */
  template: { id: string; active: boolean } | null;
}

export type ExternalOrderIssueContextResult =
  | { kind: 'OK'; context: ExternalOrderIssueContext }
  | { kind: 'PATIENT_NOT_FOUND' }
  | { kind: 'APPOINTMENT_NOT_FOUND' }
  | { kind: 'TEMPLATE_NOT_FOUND' };

export interface NewExternalOrderInput {
  patientId: string;
  locationId: string;
  appointmentId: string | null;
  professionalMembershipId: string;
  issuedById: string;
  templateId: string | null;
  content: ExternalOrderContent;
  snapshot: ExternalOrderSnapshot;
  clinicLogoKey: string | null;
}

/** El PDF ya guardado en el almacén, listo para su fila de documentos. */
export interface ArchivedExternalOrderPdf {
  documentId: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  originalName: string;
}

/** Genera y guarda el PDF de la orden (con su número ya puesto). */
export type ArchiveExternalOrderPdf = (
  order: ExternalOrder,
) => Promise<ArchivedExternalOrderPdf>;

export type VoidExternalOrderResult =
  | { kind: 'VOIDED'; order: ExternalOrder }
  | { kind: 'NOT_FOUND' }
  | { kind: 'ALREADY_VOIDED' }
  | { kind: 'NOT_ISSUED' };

export type LinkResultOutcome =
  | { kind: 'LINKED'; order: ExternalOrder }
  | { kind: 'NOT_FOUND' }
  | { kind: 'VOIDED' }
  | { kind: 'NOT_ISSUED' }
  | { kind: 'DOCUMENT_NOT_FOUND' }
  | { kind: 'DOCUMENT_VOIDED' };

export type UnlinkResultOutcome =
  | { kind: 'UNLINKED'; order: ExternalOrder }
  | { kind: 'NOT_FOUND' }
  | { kind: 'NOT_RECEIVED' };

/** Una fila de «Órdenes sin resultado» (orden ISSUED de una sede). */
export interface PendingExternalOrderRow {
  order: ExternalOrder;
  patient: { id: string; firstName: string; lastName: string };
}

export interface PendingExternalOrdersQuery {
  locationId: string;
  /** Solo las emitidas ANTES de este instante (vencidas), o todas. */
  issuedBefore: Date | null;
  skip: number;
  take: number;
}

export interface ExternalOrderSettings {
  overdueDays: number;
}

export interface ExternalOrderRepository {
  loadIssueContext(input: {
    patientId: string;
    appointmentId: string | null;
    templateId: string | null;
    issuerUserId: string;
  }): Promise<ExternalOrderIssueContextResult>;
  /**
   * Inserta (el número lo pone la BD), genera y guarda el PDF con `archive`,
   * lo archiva en los documentos del paciente (REFERRAL) y lo enlaza. Todo en
   * una transacción: si algo falla, no queda orden sin PDF.
   */
  issue(
    input: NewExternalOrderInput,
    archive: ArchiveExternalOrderPdf,
  ): Promise<ExternalOrder>;
  /**
   * `locationIds`: sedes permitidas al usuario (DX-089); `undefined` = todas.
   * Una orden de otra sede no sale (ni en la lista ni por id). null = el
   * paciente no existe en la clínica.
   */
  listForPatient(
    patientId: string,
    locationIds?: readonly string[],
  ): Promise<ExternalOrder[] | null>;
  get(
    id: string,
    locationIds?: readonly string[],
  ): Promise<ExternalOrder | null>;
  /**
   * Anula (una vez, solo ISSUED) con candado de la fila: `authorize` decide
   * antes de escribir (403). Anula el PDF archivado en la ficha, archiva el
   * PDF anulado e invalida el enlace vivo de la copia.
   */
  voidOrder(
    id: string,
    locationIds: readonly string[] | undefined,
    actor: { userId: string; reason: string },
    authorize: (order: ExternalOrder) => void,
    archive: ArchiveExternalOrderPdf,
  ): Promise<VoidExternalOrderResult>;
  /** Liga un documento vivo del MISMO paciente a una orden ISSUED. */
  linkResult(
    id: string,
    locationIds: readonly string[] | undefined,
    documentId: string,
    actorUserId: string,
  ): Promise<LinkResultOutcome>;
  /** Desliga (RESULT_RECEIVED → ISSUED); `authorize` decide antes (403). */
  unlinkResult(
    id: string,
    locationIds: readonly string[] | undefined,
    authorize: (order: ExternalOrder) => void,
  ): Promise<UnlinkResultOutcome>;
  pending(
    query: PendingExternalOrdersQuery,
  ): Promise<{ rows: PendingExternalOrderRow[]; total: number }>;
  /** Zona de una sede de la clínica (null si no existe). */
  locationTimeZone(
    locationId: string,
  ): Promise<{ timeZone: string | null } | null>;
  /** Destinatarios distintos de las órdenes desde `since` que contienen `q`. */
  recentRecipients(input: {
    since: Date;
    q: string | null;
    limit: number;
  }): Promise<string[]>;
  /** Destinatarios habituales de las plantillas activas que contienen `q`. */
  templateRecipients(input: {
    q: string | null;
    limit: number;
  }): Promise<string[]>;
  getSettings(): Promise<ExternalOrderSettings>;
  setSettings(
    next: ExternalOrderSettings,
  ): Promise<{ before: ExternalOrderSettings; after: ExternalOrderSettings }>;
}
