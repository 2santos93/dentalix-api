import type { DetectedType } from '../document-content';
import type {
  PatientDocument,
  PatientDocumentCategory,
} from '../entities/patient-document.entity';

export const PATIENT_DOCUMENT_REPOSITORY = Symbol(
  'PATIENT_DOCUMENT_REPOSITORY',
);

/**
 * Lo que el use-case ya validó. El `id` lo genera el use-case porque la
 * clave del almacén (`storageKeyFor`) lo necesita ANTES del INSERT. La sede
 * (`resolveWriteLocation`) también se resuelve antes de guardar el objeto:
 * si falla, no queda nada en el bucket. El tenant no va aquí: el repositorio
 * lo toma del contexto dentro de la transacción (RLS).
 */
export interface CreatePatientDocumentInput {
  id: string;
  patientId: string;
  locationId: string;
  category: PatientDocumentCategory;
  originalName: string;
  mimeType: DetectedType;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  clinicalDate: string | null;
  toothNumbers: string[];
  notes: string | null;
  uploadedById: string;
}

export interface PatientDocumentFilters {
  category?: PatientDocumentCategory;
  /** Diente FDI: documentos cuyo `toothNumbers` lo contiene. */
  tooth?: string;
}

/**
 * El INSERT chocó con el único parcial `patient_documents_active_sha256_key`:
 * otra subida del MISMO contenido ganó la carrera (red de seguridad del
 * `findActiveBySha256` previo). El use-case lo traduce a 409.
 */
export class DuplicateActivePatientDocumentError extends Error {
  constructor() {
    super('Documento vigente con el mismo contenido');
    this.name = 'DuplicateActivePatientDocumentError';
  }
}

export type VoidPatientDocumentOutcome =
  'VOIDED' | 'NOT_FOUND' | 'ALREADY_VOIDED';

/**
 * Todo corre bajo la RLS del tenant del contexto: un paciente o un documento
 * de otra clínica no existen para esta. No hay `update` ni `delete` A
 * PROPÓSITO: un documento solo se anula.
 */
export interface PatientDocumentRepository {
  /** Lanza `DuplicateActivePatientDocumentError` si el contenido ya está vigente. */
  create(input: CreatePatientDocumentInput): Promise<PatientDocument>;
  /**
   * Sede donde se escribe y su zona horaria. El use-case la pide ANTES de
   * guardar el objeto: si no se puede (p. ej. sede no permitida), lanza y
   * no se toca el bucket.
   */
  resolveWriteLocation(): Promise<{ locationId: string; timeZone: string }>;
  /**
   * Día civil `YYYY-MM-DD` de `now` en la zona de la sede donde se escribe
   * (la misma que `resolveWriteLocation`): tope de la fecha clínica.
   */
  clinicToday(now: Date): Promise<string>;
  /** null si no existe o es de otro paciente. */
  findById(patientId: string, id: string): Promise<PatientDocument | null>;
  /** Más reciente primero; incluye los anulados (se muestran tachados). */
  listByPatient(
    patientId: string,
    filters?: PatientDocumentFilters,
  ): Promise<PatientDocument[]>;
  void(
    id: string,
    input: { voidedById: string; reason: string },
  ): Promise<VoidPatientDocumentOutcome>;
  /** Documento NO anulado del paciente con ese contenido (duplicado → 409). */
  findActiveBySha256(
    patientId: string,
    sha256: string,
  ): Promise<PatientDocument | null>;
  /** id → nombre para mostrar de los usuarios (autor y quien anuló). */
  userNames(ids: string[]): Promise<Map<string, string>>;
}
