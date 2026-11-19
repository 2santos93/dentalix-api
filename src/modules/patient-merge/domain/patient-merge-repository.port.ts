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

/**
 * DX-266-bis: un paciente ya fusionado en el conservado al que le llegó algo
 * tarde (una escritura que validó al paciente justo antes de la fusión y
 * confirmó justo después).
 */
export interface MergeLeftover {
  absorbedPatientId: string;
  patientCode: string;
  firstName: string;
  lastName: string;
  /** Cuándo se fusionó (lo retiró la fusión). */
  mergedAt: Date;
  /** Filas por tabla de la base (`patients`: a quienes recomendó, DX-172). */
  tables: { table: string; count: number }[];
  /** Lo mismo agrupado como la vista previa de la fusión. */
  categories: { category: MergeCategory; count: number }[];
  total: number;
}

export interface MergeLeftoversResult {
  patientId: string;
  absorbedPatientId: string;
  /** Vacío si no había nada que mover (y entonces no se audita nada). */
  moved: { table: string; count: number }[];
  resolved: { kind: string; count: number }[];
  revokedLinks: LivePublicLinkCounts & { total: number };
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
  /**
   * DX-266-bis: los absorbidos por `keptId` con algo pendiente (solo los que
   * tienen algo). null si el conservado no existe o no está vivo.
   */
  leftovers(keptId: string): Promise<MergeLeftover[] | null>;
  /** DX-266-bis: vuelve a pasar al conservado lo que llegó tarde. */
  moveLeftovers(
    absorbedId: string,
    now: Date,
    ctx: AuditRequestContext,
  ): Promise<MergeLeftoversResult>;
}
