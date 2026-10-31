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
      'admin-1',
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
    const call = uc.execute(input);
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

    await expect(uc.execute(type.id, { active: false })).resolves.toMatchObject(
      { active: false, durationMinutes: 90 },
    );
    await expect(uc.execute(type.id, { color: '#12' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('404 si el tipo no existe en la clínica (o está retirado)', async () => {
    const repo = new InMemoryAppointmentTypeRepository();
    const type = repo.seed();
    repo.deleted.add(type.id);
    await expect(
      new UpdateAppointmentTypeUseCase(repo).execute(type.id, { name: 'X' }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('DeleteAppointmentTypeUseCase', () => {
  it('retira el tipo (borrado lógico) y luego da 404', async () => {
    const repo = new InMemoryAppointmentTypeRepository();
    const type = repo.seed();
    const uc = new DeleteAppointmentTypeUseCase(repo);

    await uc.execute(type.id);
    expect(repo.rows).toHaveLength(1);
    expect(repo.deleted.has(type.id)).toBe(true);
    await expect(uc.execute(type.id)).rejects.toThrow(NotFoundException);
  });
});

describe('tipo de urgencia (DX-446)', () => {
  it('nace sin urgencia salvo que se pida, y se puede marcar y desmarcar', async () => {
    const repo = new InMemoryAppointmentTypeRepository();
    const plain = await new CreateAppointmentTypeUseCase(repo).execute({
      name: 'Limpieza',
      durationMinutes: 30,
      color: '#0EA5E9',
    });
    expect(plain.isUrgent).toBe(false);
    const urgent = await new CreateAppointmentTypeUseCase(repo).execute({
      name: 'Consulta de urgencia',
      durationMinutes: 30,
      color: '#DC2626',
      isUrgent: true,
    });
    expect(urgent.isUrgent).toBe(true);
    const update = new UpdateAppointmentTypeUseCase(repo);
    expect((await update.execute(plain.id, { isUrgent: true })).isUrgent).toBe(
      true,
    );
    expect(
      (await update.execute(plain.id, { name: 'Limpieza dental' })).isUrgent,
    ).toBe(true);
    expect((await update.execute(plain.id, { isUrgent: false })).isUrgent).toBe(
      false,
    );
  });
});
