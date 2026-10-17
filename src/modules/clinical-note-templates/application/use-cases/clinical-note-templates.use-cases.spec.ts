import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InMemoryClinicalNoteTemplateRepository } from '../__fixtures__/in-memory-clinical-note-templates';
import {
  CreateNoteTemplateUseCase,
  ListNoteTemplatesUseCase,
  LoadSampleNoteTemplatesUseCase,
  UpdateNoteTemplateUseCase,
  type NoteTemplateInput,
} from './clinical-note-templates.use-cases';
import { SAMPLE_NOTE_TEMPLATES } from '../../domain/sample-templates';

const resin: NoteTemplateInput = {
  name: ' Resina ',
  category: 'Operatoria',
  body: 'Superficie {{Superficie}} con {{Material}}. {{Observaciones}}',
  prompts: [
    { label: 'Superficie', type: 'ONE', options: ['O', 'M', 'D', 'V', 'L'] },
    {
      label: 'Material',
      type: 'MULTI',
      options: ['Resina A2', 'Ionómero'],
      defaultValue: 'Resina A2',
    },
    { label: 'Observaciones', type: 'TEXT' },
  ],
};

describe('CreateNoteTemplateUseCase', () => {
  it('crea la plantilla activa, normalizada y con las preguntas en orden', async () => {
    const repo = new InMemoryClinicalNoteTemplateRepository();
    const created = await new CreateNoteTemplateUseCase(repo).execute(
      resin,
      'admin-1',
    );
    expect(created).toMatchObject({
      name: 'Resina',
      active: true,
      prompts: [
        { label: 'Superficie', type: 'ONE', position: 0, defaultValue: null },
        {
          label: 'Material',
          type: 'MULTI',
          position: 1,
          defaultValue: 'Resina A2',
        },
        { label: 'Observaciones', type: 'TEXT', position: 2, options: [] },
      ],
    });
  });

  it.each<[string, Partial<NoteTemplateInput>, RegExp]>([
    [
      'marcador sin pregunta',
      { body: '{{Superficie}} {{Material}} {{Observaciones}} {{Diente}}' },
      /marcador \{\{Diente\}\}/,
    ],
    [
      'ONE sin opciones',
      {
        prompts: [
          { label: 'Superficie', type: 'ONE', options: [] },
          ...resin.prompts.slice(1),
        ],
      },
      /necesita al menos una opción/,
    ],
  ])('400 en español: %s', async (_label, override, message) => {
    const call = new CreateNoteTemplateUseCase(
      new InMemoryClinicalNoteTemplateRepository(),
    ).execute({ ...resin, ...override });
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(message);
  });
});

describe('ListNoteTemplatesUseCase', () => {
  it('por defecto solo las activas; con includeInactive, todas', async () => {
    const repo = new InMemoryClinicalNoteTemplateRepository();
    repo.seed({ ...SAMPLE_NOTE_TEMPLATES[0] });
    repo.seed({ ...SAMPLE_NOTE_TEMPLATES[1] }, { active: false });
    const uc = new ListNoteTemplatesUseCase(repo);
    expect((await uc.execute({})).map((t) => t.name)).toEqual([
      'Exploración / control',
    ]);
    expect(await uc.execute({ includeInactive: true })).toHaveLength(2);
  });
});

describe('UpdateNoteTemplateUseCase', () => {
  it('desactiva sin tocar lo demás', async () => {
    const repo = new InMemoryClinicalNoteTemplateRepository();
    const t = repo.seed({ ...SAMPLE_NOTE_TEMPLATES[2] });
    const updated = await new UpdateNoteTemplateUseCase(repo).execute(t.id, {
      active: false,
    });
    expect(updated).toMatchObject({
      active: false,
      body: t.body,
      prompts: t.prompts,
    });
  });

  it('valida el cuerpo nuevo contra las preguntas actuales', async () => {
    const repo = new InMemoryClinicalNoteTemplateRepository();
    const t = repo.seed({ ...SAMPLE_NOTE_TEMPLATES[2] });
    await expect(
      new UpdateNoteTemplateUseCase(repo).execute(t.id, {
        body: 'Solo {{Diente}}',
      }),
    ).rejects.toThrow(/no aparece en el texto/);
  });

  it('sustituye las preguntas si vienen', async () => {
    const repo = new InMemoryClinicalNoteTemplateRepository();
    const t = repo.seed({ ...SAMPLE_NOTE_TEMPLATES[2] });
    const updated = await new UpdateNoteTemplateUseCase(repo).execute(t.id, {
      body: 'Diente {{Diente}}',
      prompts: [{ label: 'Diente', type: 'TEXT' }],
    });
    expect(updated.prompts).toEqual([
      expect.objectContaining({ label: 'Diente', type: 'TEXT', position: 0 }),
    ]);
  });

  it('404 si no es de la clínica', async () => {
    await expect(
      new UpdateNoteTemplateUseCase(
        new InMemoryClinicalNoteTemplateRepository(),
      ).execute('otra', { active: false }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('LoadSampleNoteTemplatesUseCase', () => {
  it('crea las 6 de ejemplo y, la segunda vez, ninguna (no duplica por nombre)', async () => {
    const repo = new InMemoryClinicalNoteTemplateRepository();
    const uc = new LoadSampleNoteTemplatesUseCase(repo);
    expect(await uc.execute('admin-1')).toHaveLength(6);
    expect(await uc.execute('admin-1')).toHaveLength(0);
    expect(repo.rows).toHaveLength(6);
  });

  it('respeta una plantilla propia con el mismo nombre', async () => {
    const repo = new InMemoryClinicalNoteTemplateRepository();
    repo.seed({ name: 'Resina', category: null, body: 'Propia', prompts: [] });
    const created = await new LoadSampleNoteTemplatesUseCase(repo).execute();
    expect(created.map((t) => t.name)).not.toContain('Resina');
    expect(repo.rows.filter((r) => r.name === 'Resina')).toHaveLength(1);
  });
});
