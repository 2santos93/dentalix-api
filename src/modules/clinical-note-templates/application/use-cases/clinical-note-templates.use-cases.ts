import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ClinicalNoteTemplate } from '../../domain/entities/clinical-note-template.entity';
import {
  CLINICAL_NOTE_TEMPLATE_REPOSITORY,
  type ClinicalNoteTemplateRepository,
} from '../../domain/ports/clinical-note-template-repository.port';
import {
  normalizeNoteTemplate,
  noteTemplateError,
  type NotePromptType,
  type NoteTemplateDraft,
} from '../../domain/note-template-rules';
import { SAMPLE_NOTE_TEMPLATES } from '../../domain/sample-templates';
import { NOTE_TEMPLATE_NOT_FOUND_MESSAGE } from '../note-template-errors';

export interface NotePromptInput {
  label: string;
  type: NotePromptType;
  options?: string[];
  defaultValue?: string | null;
}

export interface NoteTemplateInput {
  name: string;
  category?: string | null;
  body: string;
  prompts: NotePromptInput[];
  active?: boolean;
}

function toDraft(input: {
  name: string;
  category?: string | null;
  body: string;
  prompts: NotePromptInput[];
}): NoteTemplateDraft {
  return {
    name: input.name,
    category: input.category ?? null,
    body: input.body,
    prompts: input.prompts.map((p) => ({
      label: p.label,
      type: p.type,
      options: p.options ?? [],
      defaultValue: p.defaultValue ?? null,
    })),
  };
}

/** Valida y normaliza; 400 en español con el primer problema. */
function validDraft(draft: NoteTemplateDraft): NoteTemplateDraft {
  const error = noteTemplateError(draft);
  if (error !== null) throw new BadRequestException(error);
  return normalizeNoteTemplate(draft);
}

@Injectable()
export class ListNoteTemplatesUseCase {
  constructor(
    @Inject(CLINICAL_NOTE_TEMPLATE_REPOSITORY)
    private readonly repo: ClinicalNoteTemplateRepository,
  ) {}

  /** Por defecto solo las activas (el selector de «Nueva evolución»). */
  execute(params: {
    includeInactive?: boolean;
  }): Promise<ClinicalNoteTemplate[]> {
    return this.repo.list({ includeInactive: params.includeInactive ?? false });
  }
}

@Injectable()
export class CreateNoteTemplateUseCase {
  constructor(
    @Inject(CLINICAL_NOTE_TEMPLATE_REPOSITORY)
    private readonly repo: ClinicalNoteTemplateRepository,
  ) {}

  async execute(
    input: NoteTemplateInput,
    createdById?: string,
  ): Promise<ClinicalNoteTemplate> {
    const draft = validDraft(toDraft(input));
    const [created] = await this.repo.createMany([
      { ...draft, active: input.active ?? true, createdById },
    ]);
    return created;
  }
}

@Injectable()
export class UpdateNoteTemplateUseCase {
  constructor(
    @Inject(CLINICAL_NOTE_TEMPLATE_REPOSITORY)
    private readonly repo: ClinicalNoteTemplateRepository,
  ) {}

  /**
   * Cambia lo que venga y valida la plantilla RESULTANTE (un cuerpo nuevo se
   * comprueba contra las preguntas actuales y al revés). Ni esto ni
   * desactivarla toca las evoluciones guardadas: llevan su texto en `notes`.
   */
  async execute(
    id: string,
    input: Partial<NoteTemplateInput>,
    updatedById?: string,
  ): Promise<ClinicalNoteTemplate> {
    const current = await this.repo.findById(id);
    if (!current) throw new NotFoundException(NOTE_TEMPLATE_NOT_FOUND_MESSAGE);

    const touchesContent =
      input.name !== undefined ||
      input.category !== undefined ||
      input.body !== undefined ||
      input.prompts !== undefined;
    if (!touchesContent) {
      return this.repo.update(id, { active: input.active, updatedById });
    }

    const draft = validDraft(
      toDraft({
        name: input.name ?? current.name,
        category:
          input.category !== undefined ? input.category : current.category,
        body: input.body ?? current.body,
        prompts: input.prompts ?? current.prompts,
      }),
    );
    return this.repo.update(id, {
      name: draft.name,
      category: draft.category,
      body: draft.body,
      prompts: input.prompts !== undefined ? draft.prompts : undefined,
      active: input.active,
      updatedById,
    });
  }
}

@Injectable()
export class LoadSampleNoteTemplatesUseCase {
  constructor(
    @Inject(CLINICAL_NOTE_TEMPLATE_REPOSITORY)
    private readonly repo: ClinicalNoteTemplateRepository,
  ) {}

  /**
   * «Cargar plantillas de ejemplo»: crea las 6 de ejemplo que la clínica aún
   * no tiene (por nombre, activas o no) y devuelve las creadas. Repetirlo no
   * duplica nada ni pisa una plantilla propia con el mismo nombre.
   */
  async execute(createdById?: string): Promise<ClinicalNoteTemplate[]> {
    const existing = new Set(
      (await this.repo.list({ includeInactive: true })).map((t) => t.name),
    );
    const missing = SAMPLE_NOTE_TEMPLATES.filter((t) => !existing.has(t.name));
    if (missing.length === 0) return [];
    return this.repo.createMany(
      missing.map((t) => ({ ...validDraft(t), active: true, createdById })),
    );
  }
}
