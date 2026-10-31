import type {
  ClinicRole,
  ConsentSignerType,
  ContactChannel,
  DocumentType,
  SignatureRequestChannel,
  SignatureRequestType,
  TreatmentPlanStatus,
} from '@prisma/client';
import type { NoticeResponsible } from '../../../patients/domain/communication/notice-recipient';
import type { PlanQuoteSource } from '../../../treatment-plans/domain/ports/plan-quote-repository.port';
import type {
  PublicSignatureContext,
  SignatureRequestListRow,
  SignatureRequestRecord,
} from '../entities/signature-request.entity';

/** A quién puede ir el enlace: el paciente o, si es menor, su responsable. */
export interface SignatureRecipientContext {
  patient: {
    firstName: string;
    lastName: string;
    birthDate: Date | null;
    email: string | null;
    emergencyContactName: string | null;
    reminderOptOutAt: Date | null;
    contactChannel: ContactChannel;
  };
  /** Responsables VIVOS (DX-203) con su documento, para firmar como tutor. */
  responsibles: (NoticeResponsible & {
    document: {
      docType: DocumentType | null;
      docTypeLabel: string | null;
      docNumber: string | null;
    };
  })[];
  /** Mayoría de edad de la clínica (DX-328). */
  majorityAge: number;
  /** Zona de la sede activa o, sin ella, de la principal: da «hoy». */
  timeZone: string;
}

/** Quien puede firmar como profesional, con su rol (el modal lo muestra). */
export interface SignatureProfessional {
  id: string;
  fullName: string;
  role: ClinicRole;
}

/** Un plan del paciente para rellenar {{tratamiento}} (sin datos clínicos). */
export interface SignaturePlanOption {
  id: string;
  status: TreatmentPlanStatus;
  optionLabel: string | null;
  createdAt: Date;
}

export interface CreateSignatureRequestRepoInput {
  locationId: string;
  patientId: string;
  type: SignatureRequestType;
  channel: SignatureRequestChannel;
  /** CONSENT: plantilla y versión; BUDGET: null. */
  templateId: string | null;
  templateVersion: number | null;
  treatmentPlanId: string | null;
  title: string;
  body: string;
  /** BUDGET (DX-415): la foto del presupuesto y su hash; CONSENT: sin ellos. */
  budgetContent?: object;
  budgetContentHash?: string;
  professionalUserId: string;
  professionalName: string;
  signerType: ConsentSignerType;
  signerName: string;
  signerDocument: string | null;
  destination: string;
  destinationMasked: string;
  tokenHash: string;
  expiresAt: Date;
  createdById: string;
  createdAt: Date;
}

/** Campos que cambian a lo largo del enlace (el resto es inmutable). */
export type SignatureRequestPatch = Partial<
  Pick<
    SignatureRequestRecord,
    | 'codeHash'
    | 'codeExpiresAt'
    | 'codeSentAt'
    | 'codeSendCount'
    | 'failedAttempts'
    | 'lockedAt'
    | 'sessionHash'
    | 'sessionExpiresAt'
    | 'openedAt'
    | 'verifiedAt'
    | 'signedAt'
  >
>;

/** Eventos del paciente por el enlace (actor: el paciente, origen LINK). */
export type PublicSignatureAuditEvent =
  | { action: 'VIEW'; reason: 'SIGNATURE_LINK_OPENED' }
  | { action: 'SEND'; reason: 'SIGNATURE_CODE_SENT' }
  | {
      action: 'UPDATE';
      reason: 'SIGNATURE_CODE_VERIFIED' | 'SIGNATURE_LINK_LOCKED';
    }
  | { action: 'SIGN'; reason: 'SIGNATURE_PATIENT_SIGNED' };

/** La firma del paciente que se guarda en patient_consents (inmutable). */
export interface RemoteConsentInsert {
  templateId: string;
  templateVersion: number;
  treatmentPlanId: string | null;
  title: string;
  body: string;
  signerType: ConsentSignerType;
  signerName: string;
  signerDocument: string | null;
  professionalName: string;
  patientSignature: string;
  contentHash: string;
  signedAt: Date;
  /** Quien envió el enlace (el paciente no es un usuario). */
  recordedById: string;
  ipAddress: string | null;
  userAgent: string | null;
  remoteChannel: SignatureRequestChannel;
  remoteDestinationMasked: string;
  remoteSentAt: Date;
  remoteOpenedAt: Date;
  remoteVerifiedAt: Date;
}

/**
 * DX-415: la aceptación del presupuesto a distancia. Se escribe en la MISMA
 * transacción que la firma, con el plan y su grupo bloqueados: si el plan ya
 * no es el que se envió (`stillMatches` falso), nada se escribe y el
 * repositorio lanza `RemoteBudgetChangedError`.
 */
export interface RemoteBudgetAcceptanceInsert {
  planId: string;
  /** Sede de la solicitud: la del presupuesto enviado. */
  locationId: string;
  /** ¿El plan vivo (bloqueado) sigue siendo el presupuesto enviado? */
  stillMatches: (source: PlanQuoteSource) => boolean;
  signerName: string;
  signature: string;
  content: object;
  contentHash: string;
  acceptanceHash: string;
  acceptedAt: Date;
  /** Quien envió el enlace (el paciente no es un usuario). */
  acceptedById: string;
  ipAddress: string | null;
  userAgent: string | null;
  remoteChannel: SignatureRequestChannel;
  remoteDestinationMasked: string;
  remoteSentAt: Date;
  remoteOpenedAt: Date;
  remoteVerifiedAt: Date;
}

/** El plan dejó de ser el presupuesto enviado: «Enlace no válido». */
export class RemoteBudgetChangedError extends Error {
  constructor() {
    super('El presupuesto cambió desde el envío');
  }
}

/** Lo que el caso de uso decide con la fila bloqueada. */
export interface LockedWrite {
  patch: SignatureRequestPatch;
  audit: PublicSignatureAuditEvent[];
  consent?: RemoteConsentInsert;
  budget?: RemoteBudgetAcceptanceInsert;
}

/** El presupuesto de un plan con el formato de su sede (DX-415). */
export interface BudgetSource {
  quote: PlanQuoteSource;
  location: { id: string; locale: string | null; hourCycle: string | null };
}

export interface PublicRequestEvidence {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export type RevokeOutcome = 'REVOKED' | 'NOT_FOUND' | 'NOT_PENDING';

export const SIGNATURE_REQUEST_REPOSITORY = Symbol(
  'SIGNATURE_REQUEST_REPOSITORY',
);

export interface SignatureRequestRepository {
  /** `null` si el paciente no es de la clínica en contexto (RLS). */
  loadRecipientContext(
    patientId: string,
  ): Promise<SignatureRecipientContext | null>;

  /**
   * Un miembro VIVO de la clínica que puede firmar un consentimiento como
   * profesional (la regla de la firma en la clínica: CLINICAL_ROLES); `null`
   * si no lo es.
   */
  findProfessional(userId: string): Promise<SignatureProfessional | null>;

  /** Los mismos miembros, por nombre (el selector del modal). */
  listProfessionals(): Promise<SignatureProfessional[]>;

  /** Planes vivos del paciente que no están cancelados, más recientes primero. */
  listPlans(patientId: string): Promise<SignaturePlanOption[]>;

  /**
   * Consentimientos COMPLETOS del paciente (en la clínica, o a distancia con
   * la firma del profesional): plantilla y hora de la firma del paciente.
   */
  listCompletedConsents(
    patientId: string,
  ): Promise<{ templateId: string; signedAt: Date }[]>;

  /**
   * Inserta la solicitud y anula, en la misma transacción, las del mismo
   * paciente y plantilla (o, BUDGET, del mismo plan) que aún esperaban al
   * paciente. Devuelve el id y los
   * ids anulados (para cancelar sus emails pendientes).
   */
  create(
    input: CreateSignatureRequestRepoInput,
  ): Promise<{ id: string; supersededIds: string[] }>;

  /** Del paciente, las más recientes primero. */
  listByPatient(
    patientId: string,
    limit: number,
  ): Promise<SignatureRequestListRow[]>;

  findById(id: string): Promise<SignatureRequestListRow | null>;

  /** Anula una solicitud sin firmar ni anular. */
  revoke(input: {
    id: string;
    revokedById: string;
    now: Date;
  }): Promise<RevokeOutcome>;

  /**
   * DX-415: el presupuesto del plan del paciente, compuesto en la sede
   * `locationId` (la de la solicitud) o, sin ella, en la de escritura del
   * request. `null` si el plan o el paciente no son de esta clínica.
   */
  loadBudget(
    patientId: string,
    planId: string,
    locationId?: string,
  ): Promise<BudgetSource | null>;

  /** PÚBLICO: por hash del token, bajo la RLS de la clínica del host. */
  findByTokenHash(tokenHash: string): Promise<PublicSignatureContext | null>;

  /**
   * PÚBLICO: bloquea la fila (SELECT … FOR UPDATE), llama a `decide` con lo
   * que hay AHORA y aplica en la misma transacción lo que devuelva (cambios,
   * eventos de auditoría y, al firmar, el consentimiento). Serializa los
   * intentos sobre un mismo enlace: nunca se evalúan más de 5 códigos.
   * `null` si la fila no existe (o es de otra clínica) o, DX-461, si el
   * paciente está archivado.
   */
  withLockedRequest<T>(
    id: string,
    evidence: PublicRequestEvidence,
    decide: (request: SignatureRequestRecord) => {
      write: LockedWrite | null;
      result: T;
    },
  ): Promise<T | null>;
}
