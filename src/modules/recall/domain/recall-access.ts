import type { ClinicRole } from '@prisma/client';
import { RECALL_LIST_ROLES } from '../../auth/presentation/guards/clinic-role-sets';

/**
 * Quién gestiona la lista de recall y registra sus contactos (ADMIN y
 * RECEPTION). El mismo 403 que el `@Roles` de `/recall`: lo usa también el
 * «Agendó» con canal y nota de `POST /appointments` (`recallContact`), para
 * que agendar no sea una puerta trasera a escribir contactos.
 */
export const RECALL_LIST_FORBIDDEN_MESSAGE =
  'Tu rol no gestiona la lista de recall: es para administración y recepción.';

export function canRecordRecallContacts(role: ClinicRole | null): boolean {
  return role !== null && RECALL_LIST_ROLES.includes(role);
}
