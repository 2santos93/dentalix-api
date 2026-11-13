import type { AppointmentStatus } from '@prisma/client';
import {
  ClinicalEntry,
  type CreatedClinicalEntryRecord,
} from '../entities/clinical-entry.entity';
import type { ValidDiagnosis } from '../diagnosis-rules';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

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
  /**
   * DX-015-bis (D18): el intervalo del recall de un tipo, en la MISMA
   * transacción (un tipo inexistente o retirado da 422 y no se guarda la
   * evolución). Sin recall de ese tipo se crea con la base en el día de la
   * evolución y su sede; con uno, solo cambia el intervalo (y se reactiva).
   */
  recall?: { recallTypeId: string; intervalMonths: number };
  /** Quién escribe, para los eventos del recall (misma transacción). */
  audit?: AuditRequestContext;
}

/** DX-170: lo que el alta necesita saber de la cita a la que se liga. */
export interface ClinicalEntryAppointmentRef {
  id: string;
  patientId: string;
  status: AppointmentStatus;
  start: Date;
  /** Sede de la cita: la restricción por sedes (DX-089) se comprueba con ella. */
  locationId: string;
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
   *
   * DX-540: en la MISMA transacción del INSERT congela en la evolución el
   * registro profesional que el autor (`performedById`) tiene en esta clínica
   * (`licenseSnapshot`), y lo devuelve en `authorProfessionalLicense`.
   */
  create(
    input: CreateClinicalEntryRepoInput,
  ): Promise<CreatedClinicalEntryRecord>;

  /**
   * DX-540: registro profesional vigente del usuario en esta clínica
   * (recortado), o null si no lo tiene o no es miembro.
   */
  authorLicense(userId: string): Promise<string | null>;

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

  /**
   * DX-231: zona IANA de la sede donde se escribe una evolución SIN cita (la
   * del contexto, la misma que `create` le asigna). Decide qué es «hoy».
   */
  writeLocationTimeZone(): Promise<string>;

  /** DX-212: de `codes`, los que existen en la tabla CIE-10. */
  existingIcd10Codes(codes: string[]): Promise<Set<string>>;
}
