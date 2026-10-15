import { AppointmentStatus } from '@prisma/client';

/**
 * API-facing shape of an Appointment. Deliberately NOT the raw Prisma model:
 * repositories must `mapToEntity` before returning across the port boundary
 * (same convention as Patient / ToothRecord).
 */
export interface Appointment {
  id: string;
  tenantId: string;
  patientId: string;
  /**
   * Patient's name, joined from `Patient` so a client can label an appointment
   * without fetching the patient list. Before this existed the web app built a
   * `patientId -> name` map from `GET /patients?pageSize=100` — which silently
   * fell back to showing a raw UUID for every patient past the first 100 (the
   * endpoint's hard cap). Null only if the join is unavailable.
   */
  patientFirstName: string | null;
  patientLastName: string | null;
  providerId: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  reason: string | null;
  notes: string | null;
  createdById: string | null;
  /**
   * DX-005: cuándo se generó el enlace de confirmación vigente. null si nunca
   * se envió, o si la cita se reagendó / cambió de estado después (el enlace
   * dejó de valer).
   */
  confirmationSentAt: Date | null;
  /** DX-005: el paciente pidió que lo llamen desde el enlace (la cita sigue SCHEDULED). */
  callbackRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
