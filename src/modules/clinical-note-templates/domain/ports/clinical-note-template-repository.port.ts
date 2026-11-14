import type { ClinicalNoteTemplate } from '../entities/clinical-note-template.entity';
import type { NoteTemplateDraft } from '../note-template-rules';

// Sin `tenantId`: sale del contexto del request, nunca del cliente. Las
// preguntas llegan ya validadas y en su orden (posición = índice).
export interface CreateNoteTemplateRepoInput extends NoteTemplateDraft {
  active: boolean;
  /**
   * DX-455: ya normalizado y con formato válido. El repositorio comprueba,
   * bajo un candado por clínica, que no choca con otro (409).
   */
  shortcut?: string | null;
  createdById?: string;
}

export interface UpdateNoteTemplateRepoInput {
  name?: string;
  category?: string | null;
  body?: string;
  active?: boolean;
  /** DX-455: undefined = no cambia; null = quitarlo; texto = ya normalizado. */
  shortcut?: string | null;
  /** Si viene, sustituye TODAS las preguntas (en este orden). */
  prompts?: NoteTemplateDraft['prompts'];
  updatedById?: string;
  /**
   * DX-231: versión que el cliente leyó. Si la fila ya no la tiene, el
   * repositorio lanza 409 sin escribir nada (comprobación atómica).
   */
  expectedVersion?: number;
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
  /**
   * Sube `version` en 1. Las preguntas con `id` de la plantilla conservan ese
   * id (se actualizan en su sitio); las demás se crean y las que ya no vienen
   * se quitan.
   */
  update(
    id: string,
    input: UpdateNoteTemplateRepoInput,
  ): Promise<ClinicalNoteTemplate>;
}
