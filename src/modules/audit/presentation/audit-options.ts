import type { AuditAction, AuditResourceType } from '@prisma/client';
import type { AuditPatientRef } from '../domain/audit-event';
import type { AuditStatusChange } from '../domain/audit-metadata';

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
   * Estado antes y después cuando es fijo para el endpoint (SEC-050: anular
   * un cargo, CHARGED → VOIDED). Va a `metadata.statusChange`.
   */
  statusChange?: AuditStatusChange;
  /**
   * DX-191: búsqueda por lote/REF. La metadata guarda `lot` y `reference` de
   * la query y el nº de filas de la cabecera `X-Result-Count` de la respuesta.
   */
  search?: true;
  /**
   * DX-107: lote de importación de pacientes. La metadata guarda el SHA-256
   * del fichero, el modo y los totales de la respuesta (solo números).
   */
  importBatch?: true;
  /**
   * DX-300: receta emitida. La metadata guarda la versión de las reglas, los
   * CÓDIGOS de los avisos de seguridad (bloqueantes e informativos) y si se
   * confirmaron con motivo; ni el texto de los avisos ni el del motivo (van
   * sellados en la receta, `resourceId`).
   */
  prescriptionSafety?: true;
  /**
   * SEC-049: alta, cambio o verificación de una cobertura. La metadata guarda,
   * de la respuesta, el tipo de pagador, los 4 últimos caracteres del nº de
   * afiliado y si quedó verificada; nunca el número completo.
   */
  coverage?: true;
  /**
   * DX-051: reasignación de la imputación de un abono. La metadata guarda, de
   * la respuesta, la moneda del plan, el modo y los importes por ítem antes y
   * después (ids e importes; nada del paciente).
   */
  allocation?: true;
  /**
   * DX-377: alta de un abono. Si la respuesta trae una referencia repetida
   * confirmada, la metadata guarda la confirmación y los ids de los abonos
   * repetidos; nunca la referencia ni el motivo.
   */
  paymentReference?: true;
}
