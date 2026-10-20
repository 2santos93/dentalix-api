import type { DetectedType } from '../document-content';

/** Espejo del enum `PatientDocumentCategory` de la BD (DX-151). */
export type PatientDocumentCategory =
  'XRAY' | 'PHOTO' | 'REFERRAL' | 'SIGNED_CONSENT' | 'REPORT' | 'OTHER';

/**
 * Un documento del paciente tal como lo guarda la BD (`patient_documents`).
 * Inmutable salvo la anulación (`void*`, una sola vez). Los nombres de quien
 * lo subió o lo anuló se resuelven aparte con `userNames`.
 */
export interface PatientDocument {
  id: string;
  tenantId: string;
  patientId: string;
  /** Sede activa al subirlo. */
  locationId: string;
  category: PatientDocumentCategory;
  /** Nombre tal como lo subió el usuario, ya normalizado (solo para mostrar). */
  originalName: string;
  /** Tipo DETECTADO por el contenido, nunca el que dijo el cliente. */
  mimeType: DetectedType;
  sizeBytes: number;
  /** SHA-256 del contenido en hex minúsculas. */
  sha256: string;
  storageKey: string;
  /** Día clínico `YYYY-MM-DD`, si se sabe. */
  clinicalDate: string | null;
  /** Dientes FDI (0..8). */
  toothNumbers: string[];
  notes: string | null;
  uploadedById: string;
  /** Hora del servidor (la fija el trigger de la BD). */
  uploadedAt: Date;
  voidedAt: Date | null;
  voidedById: string | null;
  voidReason: string | null;
  createdAt: Date;
}
