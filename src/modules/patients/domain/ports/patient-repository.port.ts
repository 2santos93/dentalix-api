import { DocType, Sex } from '@prisma/client';
import { Patient } from '../entities/patient.entity';
import type { MedicalHistoryVersionData } from '../../../medical-history/domain/ports/medical-history-repository.port';
import type { SafetyFlags } from '../../../medical-history/domain/entities/medical-history.entity';

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
  dataConsentAccepted?: boolean;
  dataConsentAt?: Date;
  dataConsentPolicyVersion?: string;
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
  list(params: ListPatientsParams): Promise<ListPatientsResult>;
  update(id: string, patch: UpdatePatientRepoInput): Promise<Patient>;
}
