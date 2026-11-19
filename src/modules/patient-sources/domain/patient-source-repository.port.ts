import type { PatientSourceKind } from '@prisma/client';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import type { PatientSourceEntity } from './patient-source';

export const PATIENT_SOURCE_REPOSITORY = Symbol('PATIENT_SOURCE_REPOSITORY');

/** La ficha de captación de un paciente (`GET /patients/:id/acquisition`). */
export interface PatientAcquisitionView {
  source: Pick<PatientSourceEntity, 'id' | 'name' | 'kind' | 'isActive'> | null;
  referredByPatient: {
    id: string;
    fullName: string;
    patientCode: string;
  } | null;
  referredByName: string | null;
  referrals: {
    count: number;
    recent: { id: string; fullName: string; createdAt: Date }[];
  };
}

export interface PatientSourceRepository {
  /** Las de la clínica (sembradas si no tiene ninguna), por orden y nombre. */
  list(includeInactive: boolean): Promise<PatientSourceEntity[]>;
  create(
    input: { name: string; kind: PatientSourceKind },
    audit: AuditRequestContext,
  ): Promise<PatientSourceEntity>;
  /** null si no existe en la clínica. */
  update(
    id: string,
    patch: { name?: string; isActive?: boolean },
    audit: AuditRequestContext,
  ): Promise<PatientSourceEntity | null>;
  /** null si el paciente no existe (vivo) en la clínica. */
  acquisition(
    patientId: string,
    recentLimit: number,
  ): Promise<PatientAcquisitionView | null>;
}
