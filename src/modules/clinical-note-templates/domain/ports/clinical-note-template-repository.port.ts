import type { ClinicalNoteTemplate } from '../entities/clinical-note-template.entity';
import type { NoteTemplateDraft } from '../note-template-rules';

// Sin `tenantId`: sale del contexto del request, nunca del cliente. Las
// preguntas llegan ya validadas y en su orden (posición = índice).
export interface CreateNoteTemplateRepoInput extends NoteTemplateDraft {
  active: boolean;
  createdById?: string;
}

export interface UpdateNoteTemplateRepoInput {
  name?: string;
  category?: string | null;
  body?: string;
  active?: boolean;
  /** Si viene, sustituye TODAS las preguntas (en este orden). */
  prompts?: NoteTemplateDraft['prompts'];
  updatedById?: string;
}

export const CLINICAL_NOTE_TEMPLATE_REPOSITORY = Symbol(
  'CLINICAL_NOTE_TEMPLATE_REPOSITORY',
);

export interface ClinicalNoteTemplateRepository {
  /** Plantillas de la clínica en contexto, por carpeta y nombre. */
  list(params: { includeInactive: boolean }): Promise<ClinicalNoteTemplate[]>;
  /**
   * Por id, activa o no. Bajo RLS: una de otra clínica da `null`, igual que
   * una inexistente.
   */
  findById(id: string): Promise<ClinicalNoteTemplate | null>;
  /** Crea varias en UNA transacción (todas o ninguna). */
  createMany(
    inputs: CreateNoteTemplateRepoInput[],
  ): Promise<ClinicalNoteTemplate[]>;
  update(
    id: string,
    input: UpdateNoteTemplateRepoInput,
  ): Promise<ClinicalNoteTemplate>;
}
