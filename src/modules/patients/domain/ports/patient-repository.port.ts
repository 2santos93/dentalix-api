import { DocType, Sex } from '@prisma/client';
import { Patient } from '../entities/patient.entity';

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
  createdById?: string;
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
