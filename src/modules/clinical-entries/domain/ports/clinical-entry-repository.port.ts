import type { AppointmentStatus } from '@prisma/client';
import { ClinicalEntry } from '../entities/clinical-entry.entity';
import type { ValidDiagnosis } from '../diagnosis-rules';
import type { RdaFacts } from '../rda-readiness';

// NOTE: deliberately NO `tenantId`/`id`/`createdAt` field — the tenant comes
// from the guarded request context (never the client, same convention as
// CreatePatientRepoInput / MedicalHistoryVersionData). `entryDate` is
// optional: the use case defaults it to "now" when the caller omits it.
export interface CreateClinicalEntryRepoInput {
  patientId: string;
  entryDate?: Date;
  reason?: string;
  notes: string;
  performedById: string;
  /** DX-170: ya validada (de esta clínica y de este paciente) por el use-case. */
  appointmentId?: string;
  /** DX-170: ya validada (de esta clínica y activa) por el use-case. */
  templateId?: string;
  /**
   * DX-212: ya validados (forma y existencia en CIE-10). Se insertan en la
   * MISMA transacción que la evolución (la BD rechaza cualquier otro caso).
   */
  diagnoses?: ValidDiagnosis[];
}

/** DX-170: lo que el alta necesita saber de la cita a la que se liga. */
export interface ClinicalEntryAppointmentRef {
  id: string;
  patientId: string;
  status: AppointmentStatus;
  start: Date;
  /** Zona IANA de la sede de la cita: decide qué es «hoy» para ella. */
  timeZone: string;
}

export interface ListClinicalEntriesParams {
  from?: Date;
  to?: Date;
}

export const CLINICAL_ENTRY_REPOSITORY = Symbol('CLINICAL_ENTRY_REPOSITORY');

export interface ClinicalEntryRepository {
  /**
   * Append-only write: always INSERTS a brand-new row. Must NEVER update or
   * delete an existing row — there is no update/delete method on this port
   * at all (immutability enforced at the interface level, not just by
   * convention).
   */
  create(input: CreateClinicalEntryRepoInput): Promise<ClinicalEntry>;

  /**
   * DX-170: cita viva por id, de cualquier paciente de la clínica. Bajo RLS,
   * una de otra clínica (o retirada) da `null`, igual que una inexistente.
   */
  findAppointment(id: string): Promise<ClinicalEntryAppointmentRef | null>;

  /**
   * Non-deleted entries for the patient, ordered by `entryDate` DESC
   * (most recent first). `from`/`to` narrow the range when provided
   * (inclusive). Sin tope a propósito (revisión DX-043): la historia
   * clínica no puede llegar incompleta sin aviso.
   */
  listByPatient(
    patientId: string,
    params?: ListClinicalEntriesParams,
  ): Promise<ClinicalEntry[]>;

  /** DX-212: de `codes`, los que existen en la tabla CIE-10. */
  existingIcd10Codes(codes: string[]): Promise<Set<string>>;

  /**
   * DX-212: lo que el RDA necesita saber de la atención de la evolución `id`
   * (paciente, diagnóstico principal, procedimientos de ese día, sede y
   * autor). `null` si la evolución no es de esta clínica (RLS) o no existe.
   */
  loadRdaFacts(id: string): Promise<RdaFacts | null>;

  /** DX-232: carga en conjunto, restringida al paciente cuando se indica. */
  loadRdaFactsBatch(
    ids: string[],
    patientId?: string,
  ): Promise<Map<string, RdaFacts>>;
}
