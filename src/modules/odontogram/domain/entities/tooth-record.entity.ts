import { CatalogKind, ToothRecordStatus, ToothSurface } from '@prisma/client';

/**
 * API-facing shape of a ToothRecord (one immutable clinical event on a
 * tooth — a diagnosis or a procedure). Deliberately NOT the raw Prisma
 * model: repositories must `mapToEntity` before returning across the port
 * boundary (same convention as Patient / MedicalHistory / ClinicalEntry /
 * DentalCatalogItem).
 *
 * This is IMMUTABLE: once created, a record is never updated or deleted
 * (content-wise). A correction = a brand-new record, never an edit of an
 * existing one. The odontogram shown on screen is the PROJECTION of all
 * of a patient's records grouped by `toothNumber` — see GetOdontogramUseCase.
 */
export interface ToothRecord {
  id: string;
  tenantId: string;
  patientId: string;
  /** FDI/ISO-3950 tooth code: permanent 11-18/21-28/31-38/41-48, primary 51-55/61-65/71-75/81-85. */
  toothNumber: string;
  /** Empty array means "whole tooth" (no specific surface). */
  surfaces: ToothSurface[];
  kind: CatalogKind;
  catalogItemId: string | null;
  status: ToothRecordStatus;
  notes: string | null;
  clinicalEntryId: string | null;
  performedById: string | null;
  /**
   * When set, this record was auto-created because a TreatmentPlanItem was
   * marked DONE (Pieza B) — it points at that plan item. Null for records
   * created directly in the odontogram.
   */
  sourcePlanItemId: string | null;
  recordedAt: Date;
  createdAt: Date;
}
