import { CatalogKind, ToothRecordStatus, ToothSurface } from '@prisma/client';
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
  recordedAt?: Date;
}

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
   * All non-deleted records for the patient (every tooth). Used by
   * GetOdontogramUseCase to build the whole-mouth projection; ordering is
   * chronological (recordedAt ASC) so a consumer that folds over the list
   * naturally lands on the most recent state last.
   */
  listByPatient(patientId: string): Promise<ToothRecord[]>;

  /**
   * Non-deleted records for a single tooth, ordered by `recordedAt` DESC
   * (most recent first) — this is the per-tooth timeline.
   */
  listByTooth(patientId: string, toothNumber: string): Promise<ToothRecord[]>;

  /**
   * The non-deleted record auto-created from a given treatment-plan item, or
   * `null` if none. Used to dedupe (Pieza B): a plan item mirrors into the
   * odontogram at most once. Read-only — does NOT violate append-only.
   */
  findBySourcePlanItem(planItemId: string): Promise<ToothRecord | null>;
}
