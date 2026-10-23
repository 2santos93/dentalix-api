import type { PatientAgreement } from '../entities/patient-agreement.entity';

export const PATIENT_AGREEMENT_REPOSITORY = Symbol(
  'PATIENT_AGREEMENT_REPOSITORY',
);

export interface ReplaceAgreementRepoInput {
  agreementId: string;
  coverageId: string | null;
  validFrom: string | null;
  validTo: string | null;
  notes: string | null;
}

/** Asignación viva de un paciente, con lo que necesita la resolución de precios. */
export interface LiveAgreementAssignment {
  agreementId: string;
  validFrom: string | null;
  validTo: string | null;
}

/** Lo mínimo de la asignación viva que necesita el resumen. */
export interface CurrentAgreementRow {
  patientId: string;
  agreementName: string;
  payerName: string;
  agreementActive: boolean;
  agreementValidFrom: string | null;
  agreementValidTo: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface PatientAgreementRepository {
  /** ¿El paciente vivo es de esta clínica? Bajo RLS, otra clínica = `false`. */
  patientExists(patientId: string): Promise<boolean>;
  /** Día civil de hoy en la zona de la sede del request (o la por defecto). */
  clinicToday(now: Date): Promise<string>;
  /** Asignación viva, o `null`. */
  current(patientId: string): Promise<PatientAgreement | null>;
  /** Asignaciones retiradas, de la más reciente a la más antigua. */
  history(patientId: string): Promise<PatientAgreement[]>;
  /**
   * Una transacción con candado por paciente: relee el convenio `FOR SHARE`
   * (vivo, activo o no), comprueba la cobertura (del paciente y del pagador del
   * convenio), retira la asignación viva y crea la nueva. Si el índice parcial
   * salta, 422 y no queda nada escrito.
   */
  replace(
    patientId: string,
    input: ReplaceAgreementRepoInput,
    by: string,
  ): Promise<PatientAgreement>;
  /** Retira la asignación viva. `false` si no había ninguna. */
  retireCurrent(patientId: string, by: string): Promise<boolean>;
  /** Contrato para la resolución de precios del plan (DX-105 Task 5). */
  currentLiveByPatient(
    patientId: string,
  ): Promise<LiveAgreementAssignment | null>;
  /** Asignación viva de cada paciente de `patientIds`: UNA consulta para el lote. */
  listCurrentByPatients(
    patientIds: readonly string[],
  ): Promise<CurrentAgreementRow[]>;
}
