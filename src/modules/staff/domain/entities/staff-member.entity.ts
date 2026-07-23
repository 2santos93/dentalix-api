import { ClinicRole } from '@prisma/client';

/**
 * API-facing shape of an active clinic staff member (for the appointments
 * provider selector). Deliberately NOT the raw Prisma `ClinicMembership`/
 * `User` join — repositories must `mapToEntity` before returning across the
 * port boundary (same convention as Patient/Appointment).
 */
export interface StaffMember {
  userId: string;
  fullName: string;
  role: ClinicRole;
}
