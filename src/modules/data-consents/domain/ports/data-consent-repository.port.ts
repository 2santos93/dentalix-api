import type {
  ConsentDecision,
  ConsentEvidence,
  DataConsentRecord,
} from '../entities/data-consent.entity';

export const DATA_CONSENT_REPOSITORY = Symbol('DATA_CONSENT_REPOSITORY');

export interface RecordConsentsCommand {
  patientId: string;
  /** Tiene que ser la versión VIGENTE de la clínica (la que se le mostró). */
  policyVersionId: string;
  decisions: ConsentDecision[];
  recordedById: string;
  evidence: ConsentEvidence;
}

export interface DataConsentRepository {
  /** Todas las filas del paciente (clínica en contexto), la más reciente primero. */
  listForPatient(patientId: string): Promise<DataConsentRecord[]>;

  /**
   * Append-only: INSERTA una fila por decisión, con la hora del servidor, y
   * actualiza en la misma transacción el resumen deprecado del paciente.
   * Lanza 409 si la clínica no tiene política o `policyVersionId` no es la
   * vigente.
   */
  record(command: RecordConsentsCommand): Promise<void>;
}
