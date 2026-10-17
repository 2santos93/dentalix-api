import { ClinicRole } from '@prisma/client';

/** «Adelantar si hay hueco» (DX-210): quién la cambia y los textos. */

/** Marcan y desmarcan la cita: recepción, el odontólogo y gestión. */
export const WANTS_EARLIER_ROLES: readonly ClinicRole[] = [
  ClinicRole.RECEPTION,
  ClinicRole.DENTIST,
  ClinicRole.ADMIN,
];

export const WANTS_EARLIER_FORBIDDEN_MESSAGE =
  'Solo recepción, los odontólogos y la administración pueden cambiar «Adelantar si hay hueco»';

export const WANTS_EARLIER_GONE_MESSAGE =
  'Esta cita ya no está para adelantar: alguien la movió, la canceló o le quitó la marca.';

export const WANTS_EARLIER_NOT_EARLIER_MESSAGE =
  'El hueco tiene que ser anterior a la cita: «Adelantar si hay hueco» no la retrasa.';

/** ¿Puede este rol marcar la cita? `null` = sin rol de clínica. */
export function canChangeWantsEarlier(role: ClinicRole | null): boolean {
  return role !== null && WANTS_EARLIER_ROLES.includes(role);
}
