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
   * Nº de registro profesional del miembro en esta clínica (DX-013).
   * Solo lo traen el perfil (`findDetailById`) y la respuesta del PATCH.
   */
  professionalLicense?: string | null;
  /** Especialidad del miembro en esta clínica (DX-324). Mismo alcance que `professionalLicense`. */
  professionalSpecialty?: string | null;
  /**
   * DX-089: sedes permitidas, solo activas. `null` = todas (sin restricción,
   * siempre en un ADMIN). Lo traen el listado (`listActive`), `findById` y
   * el perfil.
   */
  locationIds?: string[] | null;
}
