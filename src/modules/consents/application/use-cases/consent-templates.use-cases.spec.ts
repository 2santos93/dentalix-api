import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InMemoryConsentTemplateRepository } from '../__fixtures__/in-memory-consent-templates';
import {
  CreateConsentTemplateUseCase,
  ListConsentTemplatesUseCase,
  UpdateConsentTemplateUseCase,
} from './consent-templates.use-cases';

describe('CreateConsentTemplateUseCase', () => {
  it('crea una plantilla activa por defecto, con el texto recortado', async () => {
    const repo = new InMemoryConsentTemplateRepository();
    const uc = new CreateConsentTemplateUseCase(repo);

    const created = await uc.execute(
      { title: '  Endodoncia ', body: ' Yo, {{paciente}}, autorizo. ' },
      'admin-1',
    );

    expect(created).toMatchObject({
      title: 'Endodoncia',
      body: 'Yo, {{paciente}}, autorizo.',
      active: true,
      version: 1,
    });
    expect(repo.rows).toHaveLength(1);
  });

  it('rechaza título o texto en blanco', async () => {
    const uc = new CreateConsentTemplateUseCase(
      new InMemoryConsentTemplateRepository(),
    );
    await expect(uc.execute({ title: '  ', body: 'x' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(uc.execute({ title: 'x', body: '   ' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rechaza variables que no existen y dice cuáles', async () => {
    const uc = new CreateConsentTemplateUseCase(
      new InMemoryConsentTemplateRepository(),
    );
    await expect(
      uc.execute({ title: 'X', body: '{{paciente}} {{edad}}' }),
    ).rejects.toThrow(/\{\{edad\}\}/);
  });
});

describe('UpdateConsentTemplateUseCase', () => {
  it('sube la versión al cambiar el texto', async () => {
    const repo = new InMemoryConsentTemplateRepository();
    const tpl = repo.seed();
    const uc = new UpdateConsentTemplateUseCase(repo);

    const updated = await uc.execute(tpl.id, { body: 'Nuevo {{fecha}}' });

    expect(updated.body).toBe('Nuevo {{fecha}}');
    expect(updated.version).toBe(2);
  });

  it('desactivar NO sube la versión (el texto no cambió)', async () => {
    const repo = new InMemoryConsentTemplateRepository();
    const tpl = repo.seed();
    const uc = new UpdateConsentTemplateUseCase(repo);

    const updated = await uc.execute(tpl.id, { active: false });

    expect(updated.active).toBe(false);
    expect(updated.version).toBe(1);
  });

  it('reenviar el mismo texto no sube la versión', async () => {
    const repo = new InMemoryConsentTemplateRepository();
    const tpl = repo.seed();
    const uc = new UpdateConsentTemplateUseCase(repo);

    const updated = await uc.execute(tpl.id, {
      title: tpl.title,
      body: tpl.body,
    });

    expect(updated.version).toBe(1);
  });

  it('404 si la plantilla no es de esta clínica', async () => {
    const uc = new UpdateConsentTemplateUseCase(
      new InMemoryConsentTemplateRepository(),
    );
    await expect(uc.execute('otra', { active: false })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('valida las variables del texto nuevo', async () => {
    const repo = new InMemoryConsentTemplateRepository();
    const tpl = repo.seed();
    const uc = new UpdateConsentTemplateUseCase(repo);
    await expect(uc.execute(tpl.id, { body: '{{nope}}' })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('ListConsentTemplatesUseCase', () => {
  it('filtra por activas cuando se pide', async () => {
    const repo = new InMemoryConsentTemplateRepository();
    repo.seed({ title: 'B' });
    repo.seed({ title: 'A', active: false });
    const uc = new ListConsentTemplatesUseCase(repo);

    expect((await uc.execute()).map((t) => t.title)).toEqual(['A', 'B']);
    expect((await uc.execute({ active: true })).map((t) => t.title)).toEqual([
      'B',
    ]);
  });
});
