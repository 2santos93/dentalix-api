import { BadRequestException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';

/**
 * Quién tiene agenda de pacientes: odontología y administración (el titular).
 * Recepción y asistencia no atienden: ni se les bloquea la agenda, ni se les
 * buscan huecos, ni se les agenda, mueve o apunta en pendientes (DX-122, DX-161).
 */
export const ATTENDING_ROLES: readonly ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ADMIN,
];

export const NOT_ATTENDING_MESSAGE =
  'Ese miembro del equipo no atiende pacientes: no tiene agenda propia.';

/** 400 si el miembro del equipo no atiende pacientes (DX-161). */
export function assertAttendingRole(member: { role?: ClinicRole }): void {
  if (!member.role || !ATTENDING_ROLES.includes(member.role)) {
    throw new BadRequestException(NOT_ATTENDING_MESSAGE);
  }
}
