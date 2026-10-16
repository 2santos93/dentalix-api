import { ClinicalEntry } from '../entities/clinical-entry.entity';

// NOTE: deliberately NO `tenantId`/`id`/`createdAt` field — the tenant comes
// from the guarded request context (never the client, same convention as
// CreatePatientRepoInput / MedicalHistoryVersionData). `entryDate` is
// optional: the use case defaults it to "now" when the caller omits it.
export interface CreateClinicalEntryRepoInput {
  patientId: string;
  entryDate?: Date;
  reason?: string;
  notes: string;
  performedById?: string;
}

export interface ListClinicalEntriesParams {
  from?: Date;
  to?: Date;
}

/** Tope de `listByPatient` (DX-043, DB-018). */
export const CLINICAL_ENTRIES_LIMIT = 500;

export const CLINICAL_ENTRY_REPOSITORY = Symbol('CLINICAL_ENTRY_REPOSITORY');

export interface ClinicalEntryRepository {
  /**
   * Append-only write: always INSERTS a brand-new row. Must NEVER update or
   * delete an existing row — there is no update/delete method on this port
   * at all (immutability enforced at the interface level, not just by
   * convention).
   */
  create(input: CreateClinicalEntryRepoInput): Promise<ClinicalEntry>;

  /**
   * Non-deleted entries for the patient, ordered by `entryDate` DESC
   * (most recent first). `from`/`to` narrow the range when provided
   * (inclusive). At most `CLINICAL_ENTRIES_LIMIT` (the most recent ones;
   * DX-043, DB-018): older ones are reached by narrowing with `to`.
   */
  listByPatient(
    patientId: string,
    params?: ListClinicalEntriesParams,
  ): Promise<ClinicalEntry[]>;
}
