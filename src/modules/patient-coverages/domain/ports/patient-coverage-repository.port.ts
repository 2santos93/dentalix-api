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
  /** Pedida: la primera cobertura viva es principal aunque sea `false`. */
  isPrimary: boolean;
  notes: string | null;
  createdById: string;
}

/** Solo lo que cambia. `isPrimary: true` la marca principal (ver `update`). */
export interface UpdateCoverageRepoPatch {
  payerId?: string;
  planName?: string | null;
  memberNumber?: string | null;
  policyHolderName?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  notes?: string | null;
  isPrimary?: true;
  updatedById: string;
}

/** Lo mínimo de la cobertura principal viva que necesita el resumen (sin `memberNumber`). */
export interface PrimaryCoverageRow {
  patientId: string;
  payerName: string;
  planName: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface PatientCoverageRepository {
  /** ¿El paciente vivo es de esta clínica? Bajo RLS, otra clínica = `false`. */
  patientExists(patientId: string): Promise<boolean>;
  /** Día civil de hoy en la zona de la sede de escritura del request. */
  clinicToday(now: Date): Promise<string>;
  /** Vivas: principal primero, luego por alta. */
  listByPatient(patientId: string): Promise<PatientCoverage[]>;
  findById(patientId: string, id: string): Promise<PatientCoverage | null>;
  /**
   * Cobertura principal viva de cada paciente de `patientIds`, con el nombre
   * del pagador: UNA consulta para todo el lote (sin N+1). Quien no tiene
   * cobertura viva no aparece.
   */
  listPrimaryLiveByPatients(
    patientIds: readonly string[],
  ): Promise<PrimaryCoverageRow[]>;
  /**
   * Una transacción con candado por paciente: comprueba el tope (400), decide
   * si es la primera (principal) o si desmarca la anterior, y escribe. Si la
   * red del índice parcial salta, 422 y no queda nada escrito.
   */
  create(input: CreateCoverageRepoInput): Promise<PatientCoverage>;
  /** Igual que `create` para `patch.isPrimary: true`: edición y marca, o nada. */
  update(
    id: string,
    patch: UpdateCoverageRepoPatch,
  ): Promise<PatientCoverage | null>;
  /**
   * Retiro lógico. Si era la principal y quedan vivas, la más antigua pasa a
   * principal en la misma transacción. `false` si no había nada que retirar.
   */
  softDelete(id: string, updatedById: string): Promise<boolean>;
}
