import type { PatientCoverage } from '../entities/patient-coverage.entity';

export const PATIENT_COVERAGE_REPOSITORY = Symbol(
  'PATIENT_COVERAGE_REPOSITORY',
);

export interface CreateCoverageRepoInput {
  patientId: string;
  payerId: string;
  planName: string | null;
  memberNumber: string | null;
  policyHolderName: string | null;
  validFrom: string | null;
  validTo: string | null;
  isPrimary: boolean;
  notes: string | null;
  createdById: string;
}

/** Solo lo que cambia; `isPrimary` va por `setPrimary`. */
export interface UpdateCoverageRepoPatch {
  payerId?: string;
  planName?: string | null;
  memberNumber?: string | null;
  policyHolderName?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  notes?: string | null;
  updatedById: string;
}

export interface PatientCoverageRepository {
  /** ¿El paciente vivo es de esta clínica? Bajo RLS, otra clínica = `false`. */
  patientExists(patientId: string): Promise<boolean>;
  /** Día civil de hoy en la zona de la sede de escritura del request. */
  clinicToday(now: Date): Promise<string>;
  /** Vivas: principal primero, luego por alta. */
  listByPatient(patientId: string): Promise<PatientCoverage[]>;
  findById(patientId: string, id: string): Promise<PatientCoverage | null>;
  countLive(patientId: string): Promise<number>;
  create(input: CreateCoverageRepoInput): Promise<PatientCoverage>;
  update(
    id: string,
    patch: UpdateCoverageRepoPatch,
  ): Promise<PatientCoverage | null>;
  /**
   * Retiro lógico. Si era la principal y quedan vivas, la más antigua pasa a
   * principal en la misma transacción. `false` si no había nada que retirar.
   */
  softDelete(id: string, updatedById: string): Promise<boolean>;
  /**
   * Una transacción: desmarca las demás principales vivas del paciente y marca
   * esta. Si otra petición cambia la principal a la vez, la implementación
   * lanza 422 (como las demás escrituras de este puerto).
   */
  setPrimary(
    patientId: string,
    coverageId: string,
    updatedById: string,
  ): Promise<void>;
}
