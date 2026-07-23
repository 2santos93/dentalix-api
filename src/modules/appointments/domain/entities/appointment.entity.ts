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
  providerId: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  reason: string | null;
  notes: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}
