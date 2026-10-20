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
  email: string;
  role: ClinicRole;
  /**
   * Registro profesional (CO) / nº de colegiado (ES) en esta clínica (DX-013).
   * Solo lo traen el perfil (`findDetailById`) y la respuesta del PATCH.
   */
  professionalLicense?: string | null;
  /**
   * DX-089: sedes permitidas, solo activas. `null` = todas (sin restricción,
   * siempre en un ADMIN). Lo traen el listado (`listActive`) y el perfil.
   */
  locationIds?: string[] | null;
}
