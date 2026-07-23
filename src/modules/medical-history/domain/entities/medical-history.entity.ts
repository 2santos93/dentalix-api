/**
 * API-facing shape of a MedicalHistoryVersion (one anamnesis snapshot).
 * Deliberately NOT the raw Prisma model: repositories must `mapToEntity`
 * before returning across the port boundary (same convention as Patient /
 * DentalCatalogItem).
 *
 * This is APPEND-ONLY: a row, once created, is never updated. "The current
 * medical history" = the row with the highest `version` for a patient.
 */
export interface MedicalHistory {
  id: string;
  tenantId: string;
  patientId: string;
  version: number;
  allergies: string | null;
  chronicConditions: string | null;
  currentMedications: string | null;
  habits: string | null;
  medicalAlerts: string | null;
  notes: string | null;
  createdById: string | null;
  createdAt: Date;
}
