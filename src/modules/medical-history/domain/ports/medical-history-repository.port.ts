import {
  AnswerStatus,
  MedicalHistory,
  Allergy,
  Condition,
  Medication,
  Habits,
  DentalHistory,
  Surgery,
  VitalSigns,
} from '../entities/medical-history.entity';

// NO `tenantId`/`version`/`id`/`safetyFlags`/`hasCriticalAlert`: tenant de
// contexto, version calculada por el repo, banderas derivadas en el dominio.
// `pregnancy`/`semanasEmbarazo` SÍ son entrada (no se derivan de las listas);
// alimentan `deriveSafetyFlags` (la bandera `embarazo` solo con «Sí").
export interface MedicalHistoryVersionData {
  allergies?: Allergy[];
  conditions?: Condition[];
  medications?: Medication[];
  habits?: Habits;
  dentalHistory?: DentalHistory;
  surgeries?: Surgery[];
  vitalSigns?: VitalSigns;
  familyHistory?: string;
  notes?: string;
  /** Embarazo tri-estado; ausente = sin responder. */
  pregnancy?: AnswerStatus;
  semanasEmbarazo?: number;
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
