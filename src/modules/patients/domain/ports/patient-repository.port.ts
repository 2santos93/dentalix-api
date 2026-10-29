import { DocumentType, RetentionExtension, Sex } from '@prisma/client';
import { Patient } from '../entities/patient.entity';
import type { MedicalHistoryVersionData } from '../../../medical-history/domain/ports/medical-history-repository.port';
import type { SafetyFlags } from '../../../medical-history/domain/entities/medical-history.entity';
import type {
  ConsentDecision,
  ConsentEvidence,
} from '../../../data-consents/domain/entities/data-consent.entity';

/**
 * Autorización de datos registrada JUNTO con el alta (misma transacción,
 * DX-037). `versioned` es el camino normal (filas IN_PERSON contra la política
 * vigente); `legacy` traduce el booleano deprecado de clientes antiguos a una
 * fila GENERAL LEGACY. En ambos casos `Patient.dataConsent*` se deriva de la
 * fila, nunca se escribe a mano.
 */
export type CreatePatientConsent =
  | {
      kind: 'versioned';
      policyVersionId: string;
      decisions: ConsentDecision[];
      recordedById: string;
      evidence: ConsentEvidence;
    }
  | {
      kind: 'legacy';
      granted: boolean;
      legacyPolicyVersion?: string;
      recordedById?: string;
      evidence: ConsentEvidence;
    };

export interface CreatePatientRepoInput {
  firstName: string;
  lastName: string;
  docType: DocumentType;
  /** Ya normalizada (R7); null = sin etiqueta. */
  docTypeLabel: string | null;
  docNumber?: string;
  birthDate?: Date;
  sex: Sex;
  phone?: string;
  email?: string;
  address?: string;
  countryCode?: string;
  cityId?: number;
  notes?: string;
  consent?: CreatePatientConsent;
  maritalStatus?: string;
  occupation?: string;
  physicianName?: string;
  physicianPhone?: string;
  emergencyContactName?: string;
  emergencyContactRelationship?: string;
  emergencyContactPhone?: string;
  createdById?: string;
  medicalHistory?: {
    data: MedicalHistoryVersionData;
    safetyFlags: SafetyFlags;
    hasCriticalAlert: boolean;
  };
}

export interface UpdatePatientRepoInput {
  firstName?: string;
  lastName?: string;
  docType?: DocumentType;
  /**
   * Null = sin etiqueta. Ausente = no se toca, salvo que `docType` cambie el
   * tipo guardado: entonces el repositorio la borra en la misma escritura
   * (R7; la de un tipo no vale para otro).
   */
  docTypeLabel?: string | null;
  docNumber?: string | null;
  birthDate?: Date | null;
  sex?: Sex;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  countryCode?: string;
  cityId?: number;
  notes?: string | null;
  maritalStatus?: string | null;
  occupation?: string | null;
  physicianName?: string | null;
  physicianPhone?: string | null;
  emergencyContactName?: string | null;
  emergencyContactRelationship?: string | null;
  emergencyContactPhone?: string | null;
}

export interface ListPatientsParams {
  /**
   * Búsqueda libre por nombre, apellido o documento: sin distinguir tildes ni
   * mayúsculas ("jose" encuentra "José") y por subcadena.
   */
  query?: string;
  /**
   * Solo pacientes vivos con alguna cobertura viva (principal o no) de este
   * pagador (DX-153). Un pagador de otra clínica no existe bajo la RLS: lista
   * vacía.
   */
  payerId?: string;
  skip?: number;
  take?: number;
}

export interface ListPatientsResult {
  items: Patient[];
  total: number;
}

/** Lo que la regla de retención necesita saber del paciente (DX-039). */
export interface PatientRetentionState {
  lastAttentionAt: Date | null;
  retentionExtended: RetentionExtension;
}

/**
 * Lo que archivar necesita saber: la retención y cuántas citas siguen abiertas
 * (SCHEDULED/CONFIRMED, vivas). Una cita abierta de un paciente archivado
 * seguiría en la agenda y en los recordatorios apuntando a una ficha 404, y al
 * atenderla movería `last_attention_at` de un paciente ya archivado.
 */
export interface PatientArchiveState extends PatientRetentionState {
  pendingAppointments: number;
}

/**
 * Campos NO clínicos que vacía la supresión parcial (DX-039): contacto y notas
 * administrativas. Se conserva la identificación que exige la HC (Res.
 * 1995/1999: nombre, documento, nacimiento, sexo, residencia, estado civil,
 * ocupación, aseguradora, médico tratante y responsable/acudiente). Ver
 * docs/adr/0002-retencion-historia-clinica.md.
 */
export const PARTIAL_SUPPRESSION_FIELDS = [
  'phone',
  'email',
  'address',
  'notes',
  'emergencyContactName',
  'emergencyContactRelationship',
  'emergencyContactPhone',
] as const;

export interface RetentionExpiringParams {
  /** Última atención anterior a esta fecha con plazo NONE (hoy + horizonte − 15 años). */
  noneBefore: Date;
  /** Ídem con plazo DOUBLE (hoy + horizonte − 30 años). */
  doubleBefore: Date;
  skip: number;
  take: number;
}

export const PATIENT_REPOSITORY = Symbol('PATIENT_REPOSITORY');

export interface PatientRepository {
  create(input: CreatePatientRepoInput): Promise<Patient>;
  findById(id: string): Promise<Patient | null>;
  /** Orden: (createdAt DESC, id DESC), estable entre páginas. */
  list(params: ListPatientsParams): Promise<ListPatientsResult>;
  /** Pacientes vivos del tenant del contexto, con un COUNT (sin listar). */
  count(): Promise<number>;
  update(id: string, patch: UpdatePatientRepoInput): Promise<Patient>;
  /**
   * Archiva (borrado blando) el paciente vivo `id`. En UNA transacción con el
   * paciente bloqueado (FOR UPDATE: una evolución concurrente mueve
   * `last_attention_at` en esa misma fila), llama a `assertCanArchive`, que
   * lanza si la HC sigue en retención o hay citas abiertas. 404 si no existe
   * en el tenant.
   */
  archive(
    id: string,
    assertCanArchive: (state: PatientArchiveState) => void,
  ): Promise<void>;
  /** Cambia la retención extendida y deja el rastro con motivo y autor. */
  setRetentionExtension(
    id: string,
    input: { value: RetentionExtension; reason: string; actorId: string },
  ): Promise<Patient>;
  /**
   * Supresión parcial: vacía `PARTIAL_SUPPRESSION_FIELDS`, retira la
   * autorización de MARKETING vigente (fila nueva `granted=false`, la
   * historia de consentimientos es append-only) y deja el rastro. Llama a
   * `assertAllowed` con el paciente bloqueado antes de escribir.
   */
  partiallySuppress(
    id: string,
    input: {
      reason: string;
      actorId: string;
      assertAllowed: (state: PatientRetentionState) => void;
    },
  ): Promise<Patient>;
  /** Pacientes vivos cuya retención (no PERMANENT) termina antes del horizonte. */
  listRetentionExpiring(
    params: RetentionExpiringParams,
  ): Promise<ListPatientsResult>;
}
