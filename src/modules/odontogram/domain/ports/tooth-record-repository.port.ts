import {
  CatalogKind,
  ToothRecordOrigin,
  ToothRecordStatus,
  ToothSurface,
} from '@prisma/client';
import { ToothRecord } from '../entities/tooth-record.entity';

// NOTE: deliberately NO `tenantId`/`id`/`createdAt` field — the tenant comes
// from the guarded request context (never the client, same convention as
// CreateClinicalEntryRepoInput / CreatePatientRepoInput). `performedById` is
// forwarded here as an already-resolved value (the use case sources it from
// `req.user.sub`, never from the client body).
export interface CreateToothRecordRepoInput {
  patientId: string;
  toothNumber: string;
  surfaces: ToothSurface[];
  kind: CatalogKind;
  catalogItemId?: string;
  status?: ToothRecordStatus;
  notes?: string;
  clinicalEntryId?: string;
  performedById?: string;
  /** Set only when this record mirrors a treatment-plan item marked DONE (Pieza B). */
  sourcePlanItemId?: string;
  /** DX-120: THIS_CLINIC si se omite (valor por defecto de la columna). */
  origin?: ToothRecordOrigin;
  recordedAt?: Date;
}

/**
 * DX-120: anulación de `target` (otra fila, append-only). Copia el diente, las
 * caras, el tipo y el origen del anulado para que el historial la lea sola; la
 * fecha la pone la BD.
 */
export interface CreateToothRecordVoidRepoInput {
  patientId: string;
  target: ToothRecord;
  reason: string;
  performedById: string;
}

export type CreateToothRecordVoidOutcome =
  | { kind: 'CREATED'; record: ToothRecord }
  /** El índice único parcial ya tenía una anulación de ese registro. */
  | { kind: 'ALREADY_VOIDED' };

export const TOOTH_RECORD_REPOSITORY = Symbol('TOOTH_RECORD_REPOSITORY');

export interface ToothRecordRepository {
  /**
   * Append-only write: always INSERTS a brand-new row. Must NEVER update or
   * delete an existing row — there is no update/delete method on this port
   * at all (immutability enforced at the interface level, not just by
   * convention).
   */
  create(input: CreateToothRecordRepoInput): Promise<ToothRecord>;

  /**
   * All non-deleted records for the patient (every tooth), DX-120: void
   * records included (the projection filters them out, see
   * `activeRecords`). Used by
   * GetOdontogramUseCase to build the whole-mouth projection; ordering is
   * chronological (recordedAt ASC) so a consumer that folds over the list
   * naturally lands on the most recent state last. NO limit on purpose
   * (DX-043): the projection needs every record, and truncating the oldest
   * or the newest would draw a wrong mouth.
   */
  listByPatient(patientId: string): Promise<ToothRecord[]>;

  /**
   * Non-deleted records for a single tooth (void records included, DX-120),
   * ordered by `recordedAt` DESC
   * (most recent first) — this is the per-tooth timeline. Sin tope a
   * propósito (revisión DX-043): es dato clínico.
   */
  listByTooth(patientId: string, toothNumber: string): Promise<ToothRecord[]>;

  /** DX-120: un registro del paciente (bajo RLS), anulación incluida; null si no existe. */
  findById(patientId: string, id: string): Promise<ToothRecord | null>;

  /** DX-120: INSERTA la anulación; nunca toca el registro anulado. */
  createVoid(
    input: CreateToothRecordVoidRepoInput,
  ): Promise<CreateToothRecordVoidOutcome>;

  /**
   * DX-120: nombre de los usuarios que son (o fueron) miembros de ESTA
   * clínica, por id — para firmar el historial. Un id ajeno no aparece.
   */
  memberNames(userIds: readonly string[]): Promise<Map<string, string>>;

  /** Zona IANA de la sede activa (o la por defecto): corta los días de `asOf`. */
  clinicTimeZone(): Promise<string>;

  /**
   * DX-207: ¿la prestación está en el catálogo de ESTA clínica (bajo RLS, sin
   * borrar)? `tooth_records.catalogItemId` no tiene FK: sin esto se guardaba
   * una referencia al catálogo de otra clínica.
   */
  catalogItemExists(catalogItemId: string): Promise<boolean>;

  /**
   * DX-207: ¿la evolución es de ESTE paciente en ESTA clínica (bajo RLS, sin
   * borrar)? `tooth_records.clinicalEntryId` tampoco tiene FK.
   */
  clinicalEntryOfPatientExists(
    patientId: string,
    clinicalEntryId: string,
  ): Promise<boolean>;
}
