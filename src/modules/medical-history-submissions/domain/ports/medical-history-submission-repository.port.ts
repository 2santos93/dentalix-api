import type { MedicalHistorySubmissionStatus } from '@prisma/client';
import type { MedicalHistory } from '../../../medical-history/domain/entities/medical-history.entity';
import type { MedicalHistoryVersionData } from '../../../medical-history/domain/ports/medical-history-repository.port';
import type { AnamnesisAnswers } from '../anamnesis-questionnaire';
import type {
  MedicalHistorySubmission,
  SubmissionSummary,
} from '../entities/medical-history-submission.entity';

export const MEDICAL_HISTORY_SUBMISSION_REPOSITORY = Symbol(
  'MEDICAL_HISTORY_SUBMISSION_REPOSITORY',
);

/** Lo que hace falta para emitir el enlace y armar el mensaje. */
export interface RequestContext {
  patient: {
    id: string;
    firstName: string;
    phone: string | null;
    reminderOptOutAt: Date | null;
    contactChannel: string;
  };
  clinicName: string;
  /** El paciente ya tiene vigente la autorización SENSITIVE_HEALTH. */
  sensitiveHealthGranted: boolean;
  /** La clínica tiene publicada su política de datos (para pedirla). */
  hasPrivacyPolicy: boolean;
}

export interface RequestAppointment {
  id: string;
  patientId: string;
  locationId: string;
  start: Date;
  status: string;
}

export interface IssueRequestInput {
  patientId: string;
  appointmentId: string | null;
  /** Sede de la cita; `null` = la de escritura de la sesión. */
  locationId: string | null;
  tokenHash: string;
  expiresAt: Date;
  questionnaireVersion: string;
  createdById: string;
}

export interface IssuedRequest {
  submission: MedicalHistorySubmission;
  /** Región por defecto del teléfono de la sede (DX-329); null: ninguna. */
  locationPhoneRegion: string | null;
}

/** Lo que ve el paciente (y lo que hace falta para decidir si puede). */
export interface PublicSubmissionView {
  submission: MedicalHistorySubmission;
  patientFirstName: string;
  patientDeleted: boolean;
  clinic: { name: string; logoUrl: string | null; primaryColor: string | null };
  sensitiveHealthGranted: boolean;
  policy: {
    id: string;
    version: number;
    sensitiveHealthText: string;
    policyText: string;
  } | null;
}

export interface SubmitInput {
  id: string;
  patientId: string;
  answers: AnamnesisAnswers;
  now: Date;
  /** Autorización SENSITIVE_HEALTH que da el paciente en el formulario. */
  consentPolicyVersionId: string | null;
  evidence: { ipAddress: string | null; userAgent: string | null };
  requestId: string | null;
}

export type SubmitOutcome = 'SUBMITTED' | 'GONE';

export interface SubmissionDetail {
  submission: MedicalHistorySubmission;
  summary: SubmissionSummary;
}

export interface AcceptInput {
  id: string;
  reviewerId: string;
  /** Versión a crear a partir de la vigente (leída bajo el candado). */
  build: (current: MedicalHistory | null) => MedicalHistoryVersionData;
}

export type ReviewOutcome =
  | { kind: 'OK'; submission: MedicalHistorySubmission }
  | { kind: 'NOT_FOUND' }
  | { kind: 'CONFLICT'; status: MedicalHistorySubmissionStatus };

export interface MedicalHistorySubmissionRepository {
  loadRequestContext(patientId: string): Promise<RequestContext | null>;
  findAppointment(appointmentId: string): Promise<RequestAppointment | null>;
  /**
   * Emite el enlace y, en la MISMA transacción, anula los anteriores del
   * paciente que aún esperaban respuesta (un solo enlace vivo por paciente).
   */
  issue(input: IssueRequestInput): Promise<IssuedRequest>;
  listForPatient(
    patientId: string,
    limit: number,
  ): Promise<SubmissionSummary[]>;
  /** Bandeja: por estado, en las sedes del alcance de la sesión. */
  listInbox(
    status: MedicalHistorySubmissionStatus,
    limit: number,
  ): Promise<SubmissionSummary[]>;
  countInbox(status: MedicalHistorySubmissionStatus): Promise<number>;
  findDetail(id: string): Promise<SubmissionDetail | null>;
  findByTokenHash(tokenHash: string): Promise<PublicSubmissionView | null>;
  /** Guarda las respuestas si el enlace sigue abierto (si no, `GONE`). */
  submit(input: SubmitInput): Promise<SubmitOutcome>;
  /**
   * Acepta en UNA transacción: crea exactamente una versión de la HC
   * (origen PATIENT_FORM, autor = quien revisa) y pasa el envío de SUBMITTED
   * a ACCEPTED apuntando a ella. O las dos cosas, o ninguna.
   */
  accept(input: AcceptInput): Promise<ReviewOutcome>;
  reject(input: {
    id: string;
    reviewerId: string;
    reason: string;
  }): Promise<ReviewOutcome>;
  /** Anula un enlace que aún espera al paciente. */
  revoke(input: { id: string; now: Date }): Promise<ReviewOutcome>;
}

/** La política de datos cambió mientras el paciente llenaba el formulario. */
export class OutdatedPolicyError extends Error {
  constructor() {
    super('privacy policy changed');
  }
}
