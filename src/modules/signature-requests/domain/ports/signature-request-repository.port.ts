import type {
  ConsentSignerType,
  ContactChannel,
  DocumentType,
  SignatureRequestChannel,
  SignatureRequestType,
} from '@prisma/client';
import type { NoticeResponsible } from '../../../patients/domain/communication/notice-recipient';
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

export interface CreateSignatureRequestRepoInput {
  locationId: string;
  patientId: string;
  type: SignatureRequestType;
  channel: SignatureRequestChannel;
  templateId: string;
  templateVersion: number;
  treatmentPlanId: string | null;
  title: string;
  body: string;
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

/** Lo que el caso de uso decide con la fila bloqueada. */
export interface LockedWrite {
  patch: SignatureRequestPatch;
  audit: PublicSignatureAuditEvent[];
  consent?: RemoteConsentInsert;
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
   * Un miembro VIVO de la clínica con rol clínico (puede firmar como
   * profesional); `null` si no lo es.
   */
  findProfessional(
    userId: string,
  ): Promise<{ id: string; fullName: string } | null>;

  /** Miembros vivos con rol clínico, por nombre (el selector del modal). */
  listProfessionals(): Promise<{ id: string; fullName: string }[]>;

  /**
   * Inserta la solicitud y anula, en la misma transacción, las del mismo
   * paciente y plantilla que aún esperaban al paciente. Devuelve el id y los
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

  /** PÚBLICO: por hash del token, bajo la RLS de la clínica del host. */
  findByTokenHash(tokenHash: string): Promise<PublicSignatureContext | null>;

  /**
   * PÚBLICO: bloquea la fila (SELECT … FOR UPDATE), llama a `decide` con lo
   * que hay AHORA y aplica en la misma transacción lo que devuelva (cambios,
   * eventos de auditoría y, al firmar, el consentimiento). Serializa los
   * intentos sobre un mismo enlace: nunca se evalúan más de 5 códigos.
   * `null` si la fila no existe (o es de otra clínica).
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
