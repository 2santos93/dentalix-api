import { MedicalHistory } from '../entities/medical-history.entity';

// NOTE: deliberately NO `tenantId`/`version`/`id` fields — the tenant comes
// from the guarded request context (never the client, same convention as
// CreatePatientRepoInput / CreateDentalCatalogItemRepoInput), and `version`
// is always computed by the repository (append-only: never chosen by a
// caller).
export interface MedicalHistoryVersionData {
  allergies?: string;
  chronicConditions?: string;
  currentMedications?: string;
  habits?: string;
  medicalAlerts?: string;
  notes?: string;
}

export const MEDICAL_HISTORY_REPOSITORY = Symbol('MEDICAL_HISTORY_REPOSITORY');

export interface MedicalHistoryRepository {
  /** Highest-version, non-deleted row for the patient, or null if none exists. */
  getLatest(patientId: string): Promise<MedicalHistory | null>;

  /**
   * Append-only write: computes `version = (latest?.version ?? 0) + 1` for
   * this patient and INSERTS a brand-new row. Must NEVER update or delete an
   * existing row — the previous version stays intact and retrievable.
   */
  createVersion(
    patientId: string,
    data: MedicalHistoryVersionData,
    createdById?: string,
  ): Promise<MedicalHistory>;
}
