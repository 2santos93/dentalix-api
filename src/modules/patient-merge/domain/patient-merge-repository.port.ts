import type { DocumentType } from '@prisma/client';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import type { LivePublicLinkCounts } from '../../patients/domain/live-public-links';
import type { DuplicateReason } from './duplicate-reasons';
import type { MergeCategory } from './merge-categories';
import type { MergeBlockerCode } from './merge-errors';
import type {
  MergeFieldChoices,
  MergeFieldGroup,
  MergeFieldValues,
} from './merge-fields';

export const PATIENT_MERGE_REPOSITORY = Symbol('PATIENT_MERGE_REPOSITORY');

/** Lo que la lista de duplicados enseña de cada paciente (sin datos clínicos). */
export interface DuplicatePatientSummary {
  id: string;
  patientCode: string;
  firstName: string;
  lastName: string;
  documentType: DocumentType;
  docTypeLabel: string | null;
  docNumber: string | null;
  /** Día civil AAAA-MM-DD. */
  birthDate: string | null;
  phone: string | null;
  email: string | null;
  createdAt: Date;
  lastAttentionAt: Date | null;
}

export interface DuplicatePair {
  /** La pareja en orden de id (como la guarda «No es duplicado»). */
  patients: [DuplicatePatientSummary, DuplicatePatientSummary];
  reasons: DuplicateReason[];
}

export interface ListDuplicatesParams {
  locationId?: string;
  skip: number;
  take: number;
}

export interface MergeSide {
  id: string;
  patientCode: string;
  createdAt: Date;
  lastAttentionAt: Date | null;
  /** Nombre de la ciudad de `fields.cityId` (para enseñarla), o null. */
  cityName: string | null;
  fields: MergeFieldValues;
  counts: { category: MergeCategory; count: number }[];
}

export interface MergePreview {
  kept: MergeSide;
  absorbed: MergeSide;
  blockers: MergeBlockerCode[];
  /** Enlaces públicos vivos del absorbido: la fusión los anula. */
  absorbedLiveLinks: LivePublicLinkCounts & { total: number };
}

export interface MergeInput {
  keptId: string;
  absorbedId: string;
  choices: MergeFieldChoices;
}

export interface MergeResult {
  patientId: string;
  absorbedPatientId: string;
  moved: { table: string; count: number }[];
  resolved: { kind: string; count: number }[];
  revokedLinks: LivePublicLinkCounts & { total: number };
  /** Grupos de la ficha que se tomaron del absorbido. */
  fieldsFromAbsorbed: MergeFieldGroup[];
}

export interface PatientMergeRepository {
  listDuplicates(
    params: ListDuplicatesParams,
  ): Promise<{ items: DuplicatePair[]; total: number }>;
  /** false si alguno no existe (o no está vivo) en la clínica. */
  dismiss(
    patientIds: [string, string],
    ctx: AuditRequestContext,
  ): Promise<boolean>;
  /** null si alguno no existe (o no está vivo) en la clínica. */
  preview(
    keptId: string,
    absorbedId: string,
    now: Date,
    ctx: AuditRequestContext,
  ): Promise<MergePreview | null>;
  merge(
    input: MergeInput,
    now: Date,
    ctx: AuditRequestContext,
  ): Promise<MergeResult>;
}
