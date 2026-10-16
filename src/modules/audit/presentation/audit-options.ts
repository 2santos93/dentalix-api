import type { AuditAction, AuditResourceType } from '@prisma/client';
import type { AuditPatientRef } from '../domain/audit-event';

export const AUDIT_OPTIONS = 'dentalix:audit';

/**
 * De dónde sale el paciente del evento:
 * - `{ param }`: el id del paciente va en la ruta (`:patientId`, o `:id` en
 *   `/patients/:id`);
 * - `{ response: 'id' }`: el `id` de la respuesta (alta de paciente);
 * - `{ lookup, param }`: el id de la ruta es de otro recurso (plan, ítem,
 *   abono, receta) y el paciente se lee de él, bajo RLS, al escribir.
 */
export type AuditPatientSource =
  | { param: string }
  | { response: 'id' }
  | { lookup: Exclude<AuditPatientRef['kind'], 'patient'>; param: string };

/** Qué se registra de un endpoint marcado con `@Audit(...)`. */
export interface AuditOptions {
  action: AuditAction;
  resource: AuditResourceType;
  /** Id del recurso: un parámetro de la ruta o el `id` de la respuesta. */
  resourceId?: { param: string } | { response: 'id' };
  patient?: AuditPatientSource;
}
