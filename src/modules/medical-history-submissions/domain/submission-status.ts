import type { MedicalHistorySubmissionStatus } from '@prisma/client';

/**
 * Estado que se ve del envío. Un enlace sin usar cuya fecha pasó está
 * caducado aunque en la BD siga `PENDING_PATIENT`: no hace falta un barrido
 * que lo marque (la caducidad la decide la hora, no un trabajo).
 */
export function effectiveSubmissionStatus(
  submission: { status: MedicalHistorySubmissionStatus; expiresAt: Date },
  now: Date,
): MedicalHistorySubmissionStatus {
  if (
    submission.status === 'PENDING_PATIENT' &&
    submission.expiresAt.getTime() <= now.getTime()
  ) {
    return 'EXPIRED';
  }
  return submission.status;
}

/** ¿El paciente todavía puede abrir y enviar este enlace? */
export function isOpenForPatient(
  submission: {
    status: MedicalHistorySubmissionStatus;
    expiresAt: Date;
    revokedAt: Date | null;
  },
  now: Date,
): boolean {
  return (
    submission.revokedAt === null &&
    effectiveSubmissionStatus(submission, now) === 'PENDING_PATIENT'
  );
}
