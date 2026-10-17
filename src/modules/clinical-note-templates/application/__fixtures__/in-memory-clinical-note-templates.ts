import { ConflictException } from '@nestjs/common';
import type { ClinicalNoteTemplate } from '../../domain/entities/clinical-note-template.entity';
import type {
  ClinicalNoteTemplateRepository,
  CreateNoteTemplateRepoInput,
  UpdateNoteTemplateRepoInput,
} from '../../domain/ports/clinical-note-template-repository.port';
import type { NoteTemplateDraft } from '../../domain/note-template-rules';
import { DUPLICATE_NOTE_TEMPLATE_MESSAGE } from '../note-template-errors';

/**
 * Repositorio de plantillas en memoria con estado: los tests afirman sobre
 * `rows` como un e2e lo haría sobre la tabla.
 */
export class InMemoryClinicalNoteTemplateRepository implements ClinicalNoteTemplateRepository {
  readonly rows: ClinicalNoteTemplate[] = [];
  private nextId = 1;

  private toPrompts(templateId: string, prompts: NoteTemplateDraft['prompts']) {
    return prompts.map((p, position) => ({
      id: `${templateId}-p${position}`,
      label: p.label,
      type: p.type,
      options: [...p.options],
      defaultValue: p.defaultValue,
      position,
    }));
  }

  seed(
    draft: NoteTemplateDraft,
    partial: Partial<ClinicalNoteTemplate> = {},
  ): ClinicalNoteTemplate {
    const id = `tpl-${this.nextId++}`;
    const row: ClinicalNoteTemplate = {
      id,
      tenantId: 't1',
      name: draft.name,
      category: draft.category,
      body: draft.body,
      active: true,
      prompts: this.toPrompts(id, draft.prompts),
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      ...partial,
    };
    this.rows.push(row);
    return structuredClone(row);
  }

  list(params: { includeInactive: boolean }): Promise<ClinicalNoteTemplate[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => params.includeInactive || r.active)
        .map((r) => structuredClone(r))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  findById(id: string): Promise<ClinicalNoteTemplate | null> {
    const row = this.rows.find((r) => r.id === id);
    return Promise.resolve(row ? structuredClone(row) : null);
  }

  createMany(
    inputs: CreateNoteTemplateRepoInput[],
  ): Promise<ClinicalNoteTemplate[]> {
    const names = new Set(this.rows.map((r) => r.name));
    if (inputs.some((i) => names.has(i.name))) {
      return Promise.reject(
        new ConflictException(DUPLICATE_NOTE_TEMPLATE_MESSAGE),
      );
    }
    return Promise.resolve(
      inputs.map((input) => this.seed(input, { active: input.active })),
    );
  }

  update(
    id: string,
    input: UpdateNoteTemplateRepoInput,
  ): Promise<ClinicalNoteTemplate> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error('not found');
    if (input.name !== undefined) row.name = input.name;
    if (input.category !== undefined) row.category = input.category;
    if (input.body !== undefined) row.body = input.body;
    if (input.active !== undefined) row.active = input.active;
    if (input.prompts !== undefined)
      row.prompts = this.toPrompts(id, input.prompts);
    return Promise.resolve(structuredClone(row));
  }
}
