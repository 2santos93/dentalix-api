import { ClinicalEntryAddendum } from '../entities/clinical-entry-addendum.entity';

// Sin `tenantId`/`id`/`createdAt`: el tenant sale del contexto de la petición
// y la fecha la pone la BD. `authorId` lo pasa el caso de uso desde el JWT.
export interface CreateClinicalEntryAddendumRepoInput {
  patientId: string;
  clinicalEntryId: string;
  reason: string;
  text: string;
  authorId: string;
}

export const CLINICAL_ENTRY_ADDENDUM_REPOSITORY = Symbol(
  'CLINICAL_ENTRY_ADDENDUM_REPOSITORY',
);

export interface ClinicalEntryAddendumRepository {
  /**
   * ¿Existe (bajo RLS, sin borrar) la evolución `entryId` de ESTE paciente?
   * Una evolución de otra clínica u otro paciente responde `false` (→ 404).
   */
  entryExists(patientId: string, entryId: string): Promise<boolean>;

  /** Append-only: siempre INSERTA. No hay método de edición ni de borrado. */
  create(
    input: CreateClinicalEntryAddendumRepoInput,
  ): Promise<ClinicalEntryAddendum>;

  /** Adendas de la evolución, en orden cronológico (la más antigua primero). */
  listByEntry(
    patientId: string,
    entryId: string,
  ): Promise<ClinicalEntryAddendum[]>;
}
