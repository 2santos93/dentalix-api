import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
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

  describe('DX-231: ids de las preguntas y versión optimista', () => {
    const base = {
      name: 'Resina',
      category: null,
      body: 'En {{Diente}} con {{Material}}.',
      prompts: [
        {
          label: 'Diente',
          type: 'TEXT' as const,
          options: [],
          defaultValue: null,
        },
        {
          label: 'Material',
          type: 'TEXT' as const,
          options: [],
          defaultValue: null,
        },
      ],
    };

    it('editar el texto de una pregunta conserva su id', async () => {
      const repo = new InMemoryClinicalNoteTemplateRepository();
      const t = repo.seed(base);
      const [diente, material] = t.prompts;
      const updated = await new UpdateNoteTemplateUseCase(repo).execute(t.id, {
        body: 'En {{Pieza}} con {{Material}}.',
        prompts: [
          { id: diente.id, label: 'Pieza', type: 'TEXT' },
          { id: material.id, label: 'Material', type: 'TEXT' },
        ],
      });
      expect(updated.prompts.map((p) => [p.id, p.label])).toEqual([
        [diente.id, 'Pieza'],
        [material.id, 'Material'],
      ]);
    });

    it('reordenar conserva los ids; una pregunta nueva recibe id nuevo y la quitada se va', async () => {
      const repo = new InMemoryClinicalNoteTemplateRepository();
      const t = repo.seed(base);
      const [diente, material] = t.prompts;
      const updated = await new UpdateNoteTemplateUseCase(repo).execute(t.id, {
        body: 'En {{Material}} y {{Nota}}.',
        prompts: [
          { id: material.id, label: 'Material', type: 'TEXT' },
          { label: 'Nota', type: 'TEXT' },
        ],
      });
      expect(updated.prompts.map((p) => p.label)).toEqual(['Material', 'Nota']);
      expect(updated.prompts[0]).toMatchObject({
        id: material.id,
        position: 0,
      });
      expect(updated.prompts[1].id).not.toBe(diente.id);
      expect(updated.prompts.some((p) => p.id === diente.id)).toBe(false);
    });

    it('un id que no es de esta plantilla se trata como pregunta nueva', async () => {
      const repo = new InMemoryClinicalNoteTemplateRepository();
      const t = repo.seed(base);
      const updated = await new UpdateNoteTemplateUseCase(repo).execute(t.id, {
        body: 'Solo {{Ajena}}.',
        prompts: [{ id: 'de-otra-plantilla', label: 'Ajena', type: 'TEXT' }],
      });
      expect(updated.prompts[0].id).not.toBe('de-otra-plantilla');
    });

    it('cada edición sube la versión en 1', async () => {
      const repo = new InMemoryClinicalNoteTemplateRepository();
      const t = repo.seed(base);
      expect(t.version).toBe(1);
      const uc = new UpdateNoteTemplateUseCase(repo);
      expect((await uc.execute(t.id, { active: false })).version).toBe(2);
      expect((await uc.execute(t.id, { name: 'Resina 2' })).version).toBe(3);
    });

    it('dos PATCH con la misma versión: el segundo da 409 «La plantilla cambió, recárgala»', async () => {
      const repo = new InMemoryClinicalNoteTemplateRepository();
      const t = repo.seed(base);
      const uc = new UpdateNoteTemplateUseCase(repo);
      await uc.execute(t.id, { name: 'Primera', version: t.version });
      const second = uc.execute(t.id, { name: 'Segunda', version: t.version });
      await expect(second).rejects.toThrow(ConflictException);
      await expect(second).rejects.toThrow('La plantilla cambió, recárgala');
      expect(repo.rows[0].name).toBe('Primera');
    });

    it('un id en mayúsculas es el mismo id: se conserva y cuenta como repetido', async () => {
      const repo = new InMemoryClinicalNoteTemplateRepository();
      const t = repo.seed(base);
      const [first] = t.prompts;
      const uc = new UpdateNoteTemplateUseCase(repo);
      const dup = uc.execute(t.id, {
        body: 'En {{Cara}} con {{Material}}.',
        prompts: [
          { id: first.id, label: 'Cara', type: 'TEXT' },
          { id: first.id.toUpperCase(), label: 'Material', type: 'TEXT' },
        ],
      });
      await expect(dup).rejects.toThrow(/mismo id/);
    });

    it('400 si dos preguntas llevan el mismo id (no se funden en una)', async () => {
      const repo = new InMemoryClinicalNoteTemplateRepository();
      const t = repo.seed(base);
      const [diente] = t.prompts;
      const call = new UpdateNoteTemplateUseCase(repo).execute(t.id, {
        body: 'En {{Cara}} con {{Material}}.',
        prompts: [
          { id: diente.id, label: 'Cara', type: 'TEXT' },
          { id: diente.id, label: 'Material', type: 'TEXT' },
        ],
      });
      await expect(call).rejects.toThrow(BadRequestException);
      await expect(call).rejects.toThrow(/mismo id/);
      expect(repo.rows[0].prompts.map((p) => p.label)).toEqual([
        'Diente',
        'Material',
      ]);
    });

    it('el caso de uso, llamado por dentro sin version, no comprueba (el DTO la exige en HTTP)', async () => {
      const repo = new InMemoryClinicalNoteTemplateRepository();
      const t = repo.seed(base);
      const uc = new UpdateNoteTemplateUseCase(repo);
      await uc.execute(t.id, { name: 'Primera' });
      await expect(
        uc.execute(t.id, { name: 'Segunda' }),
      ).resolves.toMatchObject({ version: 3 });
    });
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

describe('Atajos (DX-455)', () => {
  const create = (repo: InMemoryClinicalNoteTemplateRepository) =>
    new CreateNoteTemplateUseCase(repo);
  const update = (repo: InMemoryClinicalNoteTemplateRepository) =>
    new UpdateNoteTemplateUseCase(repo);

  it('crea con atajo recortado y tal como se escribió', async () => {
    const repo = new InMemoryClinicalNoteTemplateRepository();
    const created = await create(repo).execute({
      ...resin,
      shortcut: '  #Resina ',
    });
    expect(created.shortcut).toBe('#Resina');
  });

  it('sin atajo, o vacío, queda en null', async () => {
    const repo = new InMemoryClinicalNoteTemplateRepository();
    expect((await create(repo).execute(resin)).shortcut).toBeNull();
    expect(
      (await create(repo).execute({ ...resin, name: 'Otra', shortcut: '  ' }))
        .shortcut,
    ).toBeNull();
  });

  it('400 en español con un formato inválido', async () => {
    const repo = new InMemoryClinicalNoteTemplateRepository();
    await expect(
      create(repo).execute({ ...resin, shortcut: '#resina compuesta' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      create(repo).execute({ ...resin, shortcut: 'resina' }),
    ).rejects.toThrow(/empieza por #/);
    expect(repo.rows).toHaveLength(0);
  });

  it('409 por duplicado sin distinguir mayúsculas y por prefijo', async () => {
    const repo = new InMemoryClinicalNoteTemplateRepository();
    await create(repo).execute({
      ...resin,
      name: 'Resina compuesta',
      shortcut: '#resina',
    });
    await expect(
      create(repo).execute({ ...resin, name: 'Otra', shortcut: '#RESINA' }),
    ).rejects.toThrow(
      'El atajo #RESINA ya lo usa la plantilla «Resina compuesta».',
    );
    await expect(
      create(repo).execute({ ...resin, name: 'Otra', shortcut: '#re' }),
    ).rejects.toThrow(
      'El atajo #re choca con #resina: uno no puede empezar por el otro.',
    );
    await expect(
      create(repo).execute({ ...resin, name: 'Otra', shortcut: '#re' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('una desactivada conserva su atajo (sigue reservado)', async () => {
    const repo = new InMemoryClinicalNoteTemplateRepository();
    const t = await create(repo).execute({
      ...resin,
      name: 'Resina compuesta',
      shortcut: '#resina',
      active: false,
    });
    expect(t.active).toBe(false);
    await expect(
      create(repo).execute({ ...resin, name: 'Otra', shortcut: '#resina' }),
    ).rejects.toThrow(ConflictException);
  });

  it('edita, quita (null) y vuelve a poner el atajo sin chocar consigo misma', async () => {
    const repo = new InMemoryClinicalNoteTemplateRepository();
    const t = await create(repo).execute({ ...resin, shortcut: '#resina' });
    const renamed = await update(repo).execute(t.id, {
      shortcut: '#resina-a2',
      version: t.version,
    });
    expect(renamed).toMatchObject({ shortcut: '#resina-a2', version: 2 });
    const same = await update(repo).execute(t.id, {
      shortcut: '#RESINA-A2',
      version: 2,
    });
    expect(same.shortcut).toBe('#RESINA-A2');
    const cleared = await update(repo).execute(t.id, {
      shortcut: null,
      version: 3,
    });
    expect(cleared.shortcut).toBeNull();
    // Sin `shortcut` en el PATCH no se toca.
    const untouched = await update(repo).execute(t.id, {
      active: false,
      version: 4,
    });
    expect(untouched.shortcut).toBeNull();
  });

  it('editar el atajo a uno que choca: 409 y no cambia nada', async () => {
    const repo = new InMemoryClinicalNoteTemplateRepository();
    await create(repo).execute({
      ...resin,
      name: 'Resina compuesta',
      shortcut: '#resina',
    });
    const other = await create(repo).execute({
      ...resin,
      name: 'Otra',
      shortcut: '#endo',
    });
    await expect(
      update(repo).execute(other.id, { shortcut: '#res', version: 1 }),
    ).rejects.toThrow(/choca con #resina/);
    expect(repo.rows.find((r) => r.id === other.id)).toMatchObject({
      shortcut: '#endo',
      version: 1,
    });
  });
});
