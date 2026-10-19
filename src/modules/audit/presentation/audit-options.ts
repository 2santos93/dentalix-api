import type { AuditAction, AuditResourceType } from '@prisma/client';
import type { AuditPatientRef } from '../domain/audit-event';

export const AUDIT_OPTIONS = 'dentalix:audit';

/**
 * De dónde sale el paciente del evento:
 * - `{ param }`: el id del paciente va en la ruta (`:patientId`, o `:id` en
 *   `/patients/:id`);
 * - `{ response: 'id' }`: el `id` de la respuesta (alta de paciente);
 * - `{ response: 'patientId' }`: el `patientId` de la respuesta, cuando la
 *   ruta es de otro recurso que lo devuelve (DX-222, la cita);
 * - `{ lookup, param }`: el id de la ruta es de otro recurso (plan, ítem,
 *   abono, receta) y el paciente se lee de él, bajo RLS, al escribir.
 */
export type AuditPatientSource =
  | { param: string }
  | { response: 'id' | 'patientId' }
  | { lookup: Exclude<AuditPatientRef['kind'], 'patient'>; param: string };

/** Qué se registra de un endpoint marcado con `@Audit(...)`. */
export interface AuditOptions {
  action: AuditAction;
  resource: AuditResourceType;
  /** Id del recurso: un parámetro de la ruta o el `id` de la respuesta. */
  resourceId?: { param: string } | { response: 'id' };
  patient?: AuditPatientSource;
  /**
   * Código fijo que distingue una escritura dentro del recurso (p. ej.
   * `PARTIAL_SUPPRESSION`, DX-039). Va a `metadata.reason`; formato CODE.
   */
  reason?: string;
  /**
   * DX-191: búsqueda por lote/REF. La metadata guarda `lot` y `reference` de
   * la query y el nº de filas de la cabecera `X-Result-Count` de la respuesta.
   */
  search?: true;
}
