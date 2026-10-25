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

/**
 * Solo lo que cambia. `isPrimary: true` la marca principal (ver `update`).
 * `memberNumber` llega normalizado (`normalizeMemberNumber`).
 */
/** SEC-049: lo que el ADMIN tenía delante al verificar, y quién verifica. */
export interface VerifyCoverageRepoInput {
  checkedMemberNumber: string;
  expectedPayerId: string;
  verifiedById: string;
}

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
  /**
   * Igual que `create` para `patch.isPrimary: true`: edición y marca, o nada.
   * SEC-049: si cambia el pagador o el nº de afiliado (comparado con lo
   * guardado, con el candado tomado), borra la verificación y el editor pasa a
   * ser quien lo declaró (`declaredById`).
   */
  update(
    id: string,
    patch: UpdateCoverageRepoPatch,
  ): Promise<PatientCoverage | null>;
  /**
   * SEC-049: la marca verificada por `verifiedById` ahora, con el candado del
   * paciente tomado. 409 si el nº guardado ya no es `checkedMemberNumber` o
   * el pagador ya no es `expectedPayerId` (otra petición los cambió mientras
   * el ADMIN la revisaba). `null` si no está viva.
   */
  verify(
    id: string,
    input: VerifyCoverageRepoInput,
  ): Promise<PatientCoverage | null>;
  /**
   * Retiro lógico. Si era la principal y quedan vivas, la más antigua pasa a
   * principal en la misma transacción. `false` si no había nada que retirar.
   */
  softDelete(id: string, updatedById: string): Promise<boolean>;
}
