import { TEST_AUDIT } from '../../../audit/application/__fixtures__/test-audit-context';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InMemoryAppointmentTypeRepository } from '../__fixtures__/in-memory-appointment-types';
import {
  CreateAppointmentTypeUseCase,
  DeleteAppointmentTypeUseCase,
  ListAppointmentTypesUseCase,
  UpdateAppointmentTypeUseCase,
} from './appointment-types.use-cases';

describe('CreateAppointmentTypeUseCase', () => {
  it('crea un tipo activo, con nombre recortado y color en mayúsculas', async () => {
    const repo = new InMemoryAppointmentTypeRepository();
    const created = await new CreateAppointmentTypeUseCase(repo).execute(
      { name: '  Endodoncia ', durationMinutes: 90, color: '#7c3aed' },
      TEST_AUDIT,
    );
    expect(created).toMatchObject({
      name: 'Endodoncia',
      durationMinutes: 90,
      color: '#7C3AED',
      active: true,
    });
  });

  it.each([
    [{ name: ' ', durationMinutes: 30, color: '#7C3AED' }, /vacío/],
    [{ name: 'X', durationMinutes: 32, color: '#7C3AED' }, /múltiplo de 5/],
    [{ name: 'X', durationMinutes: 485, color: '#7C3AED' }, /múltiplo de 5/],
    [{ name: 'X', durationMinutes: 30, color: 'red' }, /#RRGGBB/],
  ])('rechaza %j con 400', async (input, message) => {
    const uc = new CreateAppointmentTypeUseCase(
      new InMemoryAppointmentTypeRepository(),
    );
    const call = uc.execute(input, TEST_AUDIT);
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(message);
  });
});

describe('ListAppointmentTypesUseCase', () => {
  it('por defecto solo los activos; con includeInactive, todos los vivos', async () => {
    const repo = new InMemoryAppointmentTypeRepository();
    repo.seed({ name: 'Limpieza' });
    repo.seed({ name: 'Blanqueamiento', active: false });
    const retired = repo.seed({ name: 'Antiguo' });
    repo.deleted.add(retired.id);
    const uc = new ListAppointmentTypesUseCase(repo);

    expect((await uc.execute({})).map((t) => t.name)).toEqual(['Limpieza']);
    expect(
      (await uc.execute({ includeInactive: true })).map((t) => t.name),
    ).toEqual(['Blanqueamiento', 'Limpieza']);
  });
});

describe('UpdateAppointmentTypeUseCase', () => {
  it('desactiva un tipo y valida lo que cambia', async () => {
    const repo = new InMemoryAppointmentTypeRepository();
    const type = repo.seed();
    const uc = new UpdateAppointmentTypeUseCase(repo);

    await expect(
      uc.execute(type.id, { active: false }, TEST_AUDIT),
    ).resolves.toMatchObject({ active: false, durationMinutes: 90 });
    await expect(
      uc.execute(type.id, { color: '#12' }, TEST_AUDIT),
    ).rejects.toThrow(BadRequestException);
  });

  it('404 si el tipo no existe en la clínica (o está retirado)', async () => {
    const repo = new InMemoryAppointmentTypeRepository();
    const type = repo.seed();
    repo.deleted.add(type.id);
    await expect(
      new UpdateAppointmentTypeUseCase(repo).execute(
        type.id,
        { name: 'X' },
        TEST_AUDIT,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('DeleteAppointmentTypeUseCase', () => {
  it('retira el tipo (borrado lógico) y luego da 404', async () => {
    const repo = new InMemoryAppointmentTypeRepository();
    const type = repo.seed();
    const uc = new DeleteAppointmentTypeUseCase(repo);

    await uc.execute(type.id, TEST_AUDIT);
    expect(repo.rows).toHaveLength(1);
    expect(repo.deleted.has(type.id)).toBe(true);
    await expect(uc.execute(type.id, TEST_AUDIT)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('tipo de urgencia (DX-446)', () => {
  it('nace sin urgencia salvo que se pida, y se puede marcar y desmarcar', async () => {
    const repo = new InMemoryAppointmentTypeRepository();
    const plain = await new CreateAppointmentTypeUseCase(repo).execute(
      {
        name: 'Limpieza',
        durationMinutes: 30,
        color: '#0EA5E9',
      },
      TEST_AUDIT,
    );
    expect(plain.isUrgent).toBe(false);
    const urgent = await new CreateAppointmentTypeUseCase(repo).execute(
      {
        name: 'Consulta de urgencia',
        durationMinutes: 30,
        color: '#DC2626',
        isUrgent: true,
      },
      TEST_AUDIT,
    );
    expect(urgent.isUrgent).toBe(true);
    const update = new UpdateAppointmentTypeUseCase(repo);
    expect(
      (await update.execute(plain.id, { isUrgent: true }, TEST_AUDIT)).isUrgent,
    ).toBe(true);
    expect(
      (await update.execute(plain.id, { name: 'Limpieza dental' }, TEST_AUDIT))
        .isUrgent,
    ).toBe(true);
    expect(
      (await update.execute(plain.id, { isUrgent: false }, TEST_AUDIT))
        .isUrgent,
    ).toBe(false);
  });
});

describe('indicaciones previas (DX-564)', () => {
  it('al crear, valida contra los idiomas de la clínica y guarda el mapa', async () => {
    const repo = new InMemoryAppointmentTypeRepository();
    repo.languages = ['es', 'en'];
    const created = await new CreateAppointmentTypeUseCase(repo).execute(
      {
        name: 'Cirugía',
        durationMinutes: 60,
        color: '#0E7490',
        preVisitInstructions: [
          { language: 'es', text: ' Ven en ayunas. ' },
          { language: 'en', text: 'Come fasting.' },
        ],
      },
      TEST_AUDIT,
    );
    expect(created.preVisitInstructions).toEqual({
      es: 'Ven en ayunas.',
      en: 'Come fasting.',
    });
  });

  it('sin el campo, crear deja {} y editar no toca lo guardado', async () => {
    const repo = new InMemoryAppointmentTypeRepository();
    const created = await new CreateAppointmentTypeUseCase(repo).execute(
      { name: 'Control', durationMinutes: 30, color: '#0E7490' },
      TEST_AUDIT,
    );
    expect(created.preVisitInstructions).toEqual({});

    const type = repo.seed({ preVisitInstructions: { es: 'Ven en ayunas.' } });
    const updated = await new UpdateAppointmentTypeUseCase(repo).execute(
      type.id,
      { name: 'Cirugía' },
      TEST_AUDIT,
    );
    expect(updated.preVisitInstructions).toEqual({ es: 'Ven en ayunas.' });
  });

  it('editar con la lista la sustituye entera; vacía = sin indicaciones', async () => {
    const repo = new InMemoryAppointmentTypeRepository();
    repo.languages = ['es', 'en'];
    const type = repo.seed({
      preVisitInstructions: { es: 'A', en: 'B' },
    });
    const uc = new UpdateAppointmentTypeUseCase(repo);
    expect(
      (
        await uc.execute(
          type.id,
          { preVisitInstructions: [{ language: 'es', text: 'C' }] },
          TEST_AUDIT,
        )
      ).preVisitInstructions,
    ).toEqual({ es: 'C' });
    expect(
      (await uc.execute(type.id, { preVisitInstructions: [] }, TEST_AUDIT))
        .preVisitInstructions,
    ).toEqual({});
  });

  it.each([
    [[{ language: 'pt', text: 'x' }], /idiomas de los pacientes/],
    [[{ language: 'es', text: 'https://x.test' }], /enlaces ni HTML/],
    [
      [
        { language: 'es', text: 'a' },
        { language: 'es', text: 'b' },
      ],
      /repetido/,
    ],
    [[{ language: 'es', text: 'a'.repeat(601) }], /600 caracteres/],
  ])('rechaza %j con 400', async (entries, message) => {
    const repo = new InMemoryAppointmentTypeRepository();
    const type = repo.seed();
    const call = new UpdateAppointmentTypeUseCase(repo).execute(
      type.id,
      { preVisitInstructions: entries },
      TEST_AUDIT,
    );
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(message);
  });
});
