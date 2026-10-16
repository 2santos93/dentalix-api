import { ClinicalEntryAddendum } from './clinical-entry-addendum.entity';

/**
 * API-facing shape of a ClinicalEntry (one clinical evolution note).
 * Deliberately NOT the raw Prisma model: repositories must `mapToEntity`
 * before returning across the port boundary (same convention as Patient /
 * MedicalHistory / DentalCatalogItem).
 *
 * This is IMMUTABLE: once created, an entry is never updated or deleted
 * (content-wise). DX-038: la BD también lo impide (trigger) y la corrección
 * es una ADENDA (`addenda`, en orden cronológico) que deja el original intacto.
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
  addenda: ClinicalEntryAddendum[];
}
