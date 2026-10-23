import type { MedicalHistorySubmissionStatus } from '@prisma/client';
import type { AnamnesisAnswers } from '../anamnesis-questionnaire';

export type { MedicalHistorySubmissionStatus };

/**
 * Un envío de la anamnesis por enlace (DX-099). Del token solo existe el
 * hash, en la BD; aquí no viaja ni eso.
 */
export interface MedicalHistorySubmission {
  id: string;
  tenantId: string;
  patientId: string;
  appointmentId: string | null;
  locationId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  status: MedicalHistorySubmissionStatus;
  questionnaireVersion: string;
  /** Lo que respondió el paciente; `null` hasta que lo envía. */
  answers: AnamnesisAnswers | null;
  submittedAt: Date | null;
  reviewedById: string | null;
  reviewedAt: Date | null;
  rejectReason: string | null;
  resultingVersionId: string | null;
  createdById: string;
  createdAt: Date;
}

/** Fila de la bandeja y del historial de la ficha: sin respuestas. */
export interface SubmissionSummary {
  id: string;
  patient: { id: string; fullName: string };
  appointment: { id: string; start: Date } | null;
  location: { id: string; name: string };
  status: MedicalHistorySubmissionStatus;
  expiresAt: Date;
  createdAt: Date;
  createdByName: string;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedByName: string | null;
  rejectReason: string | null;
  resultingVersionId: string | null;
}
