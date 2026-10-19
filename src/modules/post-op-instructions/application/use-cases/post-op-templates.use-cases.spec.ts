import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { SAMPLE_POSTOP_TEMPLATES } from '../../domain/sample-templates';
import { POSTOP_TEMPLATE_DUPLICATE_CODE_MESSAGE } from '../../domain/ports/post-op-template-repository.port';
import { InMemoryPostOpTemplateRepository } from '../__fixtures__/in-memory-post-op-templates';
import {
  CreatePostOpTemplateUseCase,
  ListPostOpTemplatesUseCase,
  LoadSamplePostOpTemplatesUseCase,
  POSTOP_TEMPLATE_NOT_FOUND_MESSAGE,
  UpdatePostOpTemplateUseCase,
} from './post-op-templates.use-cases';

function repoWithCatalog(): InMemoryPostOpTemplateRepository {
  const repo = new InMemoryPostOpTemplateRepository();
  repo.catalog.set('cat-exo', { code: 'EXO', labelEs: 'Exodoncia simple' });
  repo.catalog.set('cat-endo', { code: 'ENDO', labelEs: 'Endodoncia' });
  repo.appointmentTypes.set('type-cirugia', 'Cirugía');
  return repo;
}

describe('CreatePostOpTemplateUseCase', () => {
  it('normaliza el código a mayúsculas, recorta el texto y nace activa en la versión 1', async () => {
    const repo = repoWithCatalog();
    const uc = new CreatePostOpTemplateUseCase(repo);

    const created = await uc.execute(
      {
        code: '  poi-exo ',
        title: ' Exodoncia simple ',
        body: ' Hola {{paciente}}, llama al {{telefono_sede}}. ',
        catalogItemIds: ['cat-exo', 'cat-exo'],
        appointmentTypeIds: ['type-cirugia'],
      },
      'admin-1',
    );

    expect(created).toMatchObject({
      code: 'POI-EXO',
      title: 'Exodoncia simple',
      body: 'Hola {{paciente}}, llama al {{telefono_sede}}.',
      version: 1,
      active: true,
      createdById: 'admin-1',
      catalogItems: [
        { id: 'cat-exo', code: 'EXO', labelEs: 'Exodoncia simple' },
      ],
      appointmentTypes: [{ id: 'type-cirugia', name: 'Cirugía' }],
    });
    expect(repo.rows).toHaveLength(1);
  });

  it('rechaza las variables desconocidas y dice cuáles', async () => {
    const repo = repoWithCatalog();
    const uc = new CreatePostOpTemplateUseCase(repo);

    const attempt = uc.execute({
      code: 'POI-X',
      title: 'X',
      body: 'Hola {{paciente}}, tu {{edad}} y {{Dosis}}',
    });

    await expect(attempt).rejects.toThrow(BadRequestException);
    await expect(attempt).rejects.toThrow(
      'Variables no admitidas: {{edad}}, {{dosis}}',
    );
    expect(repo.rows).toHaveLength(0);
  });

  it('rechaza un código con formato inválido, y título o texto en blanco', async () => {
    const uc = new CreatePostOpTemplateUseCase(repoWithCatalog());
    await expect(
      uc.execute({ code: 'POI EXO', title: 'X', body: 'x' }),
    ).rejects.toThrow(/2 a 20 letras mayúsculas/);
    await expect(
      uc.execute({ code: 'POI-EXO', title: '  ', body: 'x' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      uc.execute({ code: 'POI-EXO', title: 'X', body: '   ' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('un código repetido da 409', async () => {
    const repo = repoWithCatalog();
    repo.seed({ code: 'POI-EXO' });
    const uc = new CreatePostOpTemplateUseCase(repo);

    await expect(
      uc.execute({ code: 'poi-exo', title: 'Otra', body: 'x' }),
    ).rejects.toThrow(
      new ConflictException(POSTOP_TEMPLATE_DUPLICATE_CODE_MESSAGE),
    );
  });
});

describe('UpdatePostOpTemplateUseCase', () => {
  it('un texto nuevo sube la versión', async () => {
    const repo = repoWithCatalog();
    const tpl = repo.seed();
    const uc = new UpdatePostOpTemplateUseCase(repo);

    const updated = await uc.execute(tpl.id, { body: 'Nuevo {{fecha}}' });

    expect(updated.body).toBe('Nuevo {{fecha}}');
    expect(updated.version).toBe(2);
  });

  it('solo `active` (o el mismo texto) no sube la versión', async () => {
    const repo = repoWithCatalog();
    const tpl = repo.seed();
    const uc = new UpdatePostOpTemplateUseCase(repo);

    const off = await uc.execute(tpl.id, { active: false });
    expect(off).toMatchObject({ active: false, version: 1 });

    const same = await uc.execute(tpl.id, {
      title: tpl.title,
      body: ` ${tpl.body} `,
    });
    expect(same.version).toBe(1);
  });

  it('reemplaza completos los vínculos del tipo que llega y conserva el otro', async () => {
    const repo = repoWithCatalog();
    const create = new CreatePostOpTemplateUseCase(repo);
    const tpl = await create.execute({
      code: 'POI-EXO',
      title: 'Exodoncia',
      body: 'x',
      catalogItemIds: ['cat-exo'],
      appointmentTypeIds: ['type-cirugia'],
    });
    const uc = new UpdatePostOpTemplateUseCase(repo);

    const updated = await uc.execute(tpl.id, { catalogItemIds: ['cat-endo'] });

    expect(updated.catalogItems.map((c) => c.id)).toEqual(['cat-endo']);
    expect(updated.appointmentTypes.map((t) => t.id)).toEqual(['type-cirugia']);
    expect(updated.version).toBe(1);

    const cleared = await uc.execute(tpl.id, { appointmentTypeIds: [] });
    expect(cleared.appointmentTypes).toEqual([]);
  });

  it('rechaza variables desconocidas en el texto nuevo', async () => {
    const repo = repoWithCatalog();
    const tpl = repo.seed();
    const uc = new UpdatePostOpTemplateUseCase(repo);

    await expect(uc.execute(tpl.id, { body: '{{edad}}' })).rejects.toThrow(
      'Variables no admitidas: {{edad}}',
    );
    expect(repo.rows[0].body).toBe(tpl.body);
  });

  it('una plantilla inexistente (o de otra clínica) da 404', async () => {
    const uc = new UpdatePostOpTemplateUseCase(repoWithCatalog());
    await expect(uc.execute('nope', { active: false })).rejects.toThrow(
      new NotFoundException(POSTOP_TEMPLATE_NOT_FOUND_MESSAGE),
    );
  });
});

describe('ListPostOpTemplatesUseCase', () => {
  it('filtra por `active` cuando llega', async () => {
    const repo = repoWithCatalog();
    repo.seed({ code: 'A', title: 'A' });
    repo.seed({ code: 'B', title: 'B', active: false });
    const uc = new ListPostOpTemplatesUseCase(repo);

    expect((await uc.execute()).map((t) => t.code)).toEqual(['A', 'B']);
    expect((await uc.execute({ active: true })).map((t) => t.code)).toEqual([
      'A',
    ]);
  });
});

describe('LoadSamplePostOpTemplatesUseCase', () => {
  it('crea las de ejemplo que faltan y la segunda vez no crea nada', async () => {
    const repo = repoWithCatalog();
    const uc = new LoadSamplePostOpTemplatesUseCase(repo);

    const first = await uc.execute('admin-1');
    expect(first.map((t) => t.code)).toEqual(
      SAMPLE_POSTOP_TEMPLATES.map((t) => t.code),
    );
    expect(first.every((t) => t.active && t.version === 1)).toBe(true);

    expect(await uc.execute('admin-1')).toEqual([]);
    expect(repo.rows).toHaveLength(SAMPLE_POSTOP_TEMPLATES.length);
  });

  it('no pisa una plantilla propia con el mismo código, aunque esté inactiva', async () => {
    const repo = repoWithCatalog();
    repo.seed({ code: 'POI-EXO', title: 'La mía', active: false });
    const uc = new LoadSamplePostOpTemplatesUseCase(repo);

    const created = await uc.execute();

    expect(created.map((t) => t.code)).not.toContain('POI-EXO');
    expect(created).toHaveLength(SAMPLE_POSTOP_TEMPLATES.length - 1);
    expect(repo.rows.find((r) => r.code === 'POI-EXO')?.title).toBe('La mía');
  });
});
