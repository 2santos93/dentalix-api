import { DocType, Sex } from '@prisma/client';
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
  docType: DocType;
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
  insurerEps?: string;
  physicianName?: string;
  physicianPhone?: string;
  emergencyContactName?: string;
  emergencyContactRelationship?: string;
  emergencyContactPhone?: string;
  guardianName?: string;
  guardianDocNumber?: string;
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
  docType?: DocType;
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
  insurerEps?: string | null;
  physicianName?: string | null;
  physicianPhone?: string | null;
  emergencyContactName?: string | null;
  emergencyContactRelationship?: string | null;
  emergencyContactPhone?: string | null;
  guardianName?: string | null;
  guardianDocNumber?: string | null;
}

export interface ListPatientsParams {
  /**
   * Búsqueda libre por nombre, apellido o documento: sin distinguir tildes ni
   * mayúsculas ("jose" encuentra "José") y por subcadena.
   */
  query?: string;
  skip?: number;
  take?: number;
}

export interface ListPatientsResult {
  items: Patient[];
  total: number;
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
}
