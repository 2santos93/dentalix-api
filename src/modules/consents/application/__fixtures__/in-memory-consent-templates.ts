import { ConsentTemplate } from '../../domain/entities/consent-template.entity';
import {
  ConsentTemplateRepository,
  CreateConsentTemplateRepoInput,
  UpdateConsentTemplateRepoInput,
} from '../../domain/ports/consent-template-repository.port';

/**
 * Repositorio de plantillas en memoria con estado: los tests afirman sobre
 * `rows` igual que un e2e lo haría sobre la tabla.
 */
export class InMemoryConsentTemplateRepository implements ConsentTemplateRepository {
  readonly rows: ConsentTemplate[] = [];
  private nextId = 1;

  seed(partial: Partial<ConsentTemplate> = {}): ConsentTemplate {
    const row: ConsentTemplate = {
      id: `tpl-${this.nextId++}`,
      tenantId: 't1',
      title: 'Exodoncia',
      body: 'Yo, {{paciente}}, autorizo {{tratamiento}}.',
      active: true,
      version: 1,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      ...partial,
    };
    this.rows.push(row);
    return row;
  }

  list(params?: { active?: boolean }): Promise<ConsentTemplate[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (r) => params?.active === undefined || r.active === params.active,
        )
        .sort((a, b) => a.title.localeCompare(b.title)),
    );
  }

  findById(id: string): Promise<ConsentTemplate | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }

  create(input: CreateConsentTemplateRepoInput): Promise<ConsentTemplate> {
    return Promise.resolve(
      this.seed({ title: input.title, body: input.body, active: input.active }),
    );
  }

  update(
    id: string,
    input: UpdateConsentTemplateRepoInput,
  ): Promise<ConsentTemplate> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error('not found');
    if (input.title !== undefined) row.title = input.title;
    if (input.body !== undefined) row.body = input.body;
    if (input.active !== undefined) row.active = input.active;
    if (input.bumpVersion) row.version += 1;
    return Promise.resolve({ ...row });
  }
}
