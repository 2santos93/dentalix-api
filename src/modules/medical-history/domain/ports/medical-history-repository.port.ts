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
import type {
  IdempotencyRequest,
  IdempotentRecord,
} from '../../../../shared/validation/idempotent-create';

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
    /** DX-574: clave y huella del guardado; un choque del único deshace todo. */
    idempotency?: IdempotencyRequest,
    /**
     * DX-095: recibe la versión vigente ANTES de esta (leída bajo el candado
     * del paciente, en la misma transacción), para auditar qué cambió.
     */
    onPrevious?: (previous: MedicalHistory | null) => void,
  ): Promise<MedicalHistory>;

  /**
   * DX-574: la versión que guardó esta Idempotency-Key en la clínica, con la
   * huella de su petición, o null.
   */
  findByIdempotencyKey(
    key: string,
  ): Promise<IdempotentRecord<MedicalHistory> | null>;
}
