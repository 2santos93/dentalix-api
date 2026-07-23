/**
 * API-facing shape of a ClinicalEntry (one clinical evolution note).
 * Deliberately NOT the raw Prisma model: repositories must `mapToEntity`
 * before returning across the port boundary (same convention as Patient /
 * MedicalHistory / DentalCatalogItem).
 *
 * This is IMMUTABLE: once created, an entry is never updated or deleted
 * (content-wise). A correction = a brand-new entry, never an edit of an
 * existing one.
 */
export interface ClinicalEntry {
  id: string;
  tenantId: string;
  patientId: string;
  entryDate: Date;
  reason: string | null;
  notes: string;
  performedById: string | null;
  createdAt: Date;
}
