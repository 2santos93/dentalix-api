import { ConflictException, NotFoundException } from '@nestjs/common';
import { TreatmentPlanItemStatus, TreatmentPlanStatus } from '@prisma/client';
import { CreatePlanAlternativeUseCase } from './create-plan-alternative.use-case';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';

const { DRAFT, PRESENTED, ACCEPTED, REJECTED, COMPLETED, CANCELLED } =
  TreatmentPlanStatus;

function setup() {
  const repo = new InMemoryTreatmentPlanRepository();
  return { repo, uc: new CreatePlanAlternativeUseCase(repo) };
}

describe('CreatePlanAlternativeUseCase (DX-040)', () => {
  it('abre un grupo: el origen pasa a «Opción A» y la nueva es «Opción B», con copia de los ítems', async () => {
    const { repo, uc } = setup();
    const source = repo.seedPlan({
      id: 'a',
      status: PRESENTED,
      currency: 'COP',
      patientId: 'p1',
    });
    repo.seedItem({
      planId: source.id,
      toothNumber: '36',
      price: 3500000,
      discount: 100000,
      status: TreatmentPlanItemStatus.ACCEPTED,
    });

    const created = await uc.execute(source.id, {
      createdById: 'dra',
    });

    expect(created).toMatchObject({
      status: DRAFT,
      patientId: 'p1',
      currency: 'COP',
      optionGroupId: 'a',
      optionLabel: 'Opción B',
      createdById: 'dra',
    });
    expect(repo.stored('a')).toMatchObject({
      optionGroupId: 'a',
      optionLabel: 'Opción A',
      status: PRESENTED,
    });
    const copy = await repo.findPlanById(created.id);
    expect(copy?.items).toEqual([
      expect.objectContaining({
        toothNumber: '36',
        price: 3500000,
        discount: 100000,
        status: TreatmentPlanItemStatus.PROPOSED,
      }),
    ]);
  });

  it('respeta la etiqueta que se pide y la del origen si ya tenía', async () => {
    const { repo, uc } = setup();
    repo.seedPlan({ id: 'a', optionLabel: 'Implante' });
    const created = await uc.execute('a', { optionLabel: '  Puente ' });
    expect(created.optionLabel).toBe('Puente');
    expect(repo.stored('a').optionLabel).toBe('Implante');
  });

  it('en un grupo existente sigue la letra siguiente y comparte el grupo', async () => {
    const { repo, uc } = setup();
    repo.seedPlan({ id: 'a', optionGroupId: 'a', optionLabel: 'Opción A' });
    repo.seedPlan({ id: 'b', optionGroupId: 'a', optionLabel: 'Opción B' });
    const created = await uc.execute('b', {});
    expect(created).toMatchObject({
      optionGroupId: 'a',
      optionLabel: 'Opción C',
    });
  });

  it('no repite letra aunque falte una del medio', async () => {
    const { repo, uc } = setup();
    repo.seedPlan({ id: 'a', optionGroupId: 'a', optionLabel: 'Opción A' });
    repo.seedPlan({ id: 'c', optionGroupId: 'a', optionLabel: 'Opción C' });
    const created = await uc.execute('a', {});
    expect(created.optionLabel).toBe('Opción D');
  });

  it.each([ACCEPTED, COMPLETED])(
    'si una opción del grupo ya está %s, no se abren más alternativas (409)',
    async (status) => {
      const { repo, uc } = setup();
      repo.seedPlan({ id: 'a', optionGroupId: 'a', status });
      repo.seedPlan({ id: 'b', optionGroupId: 'a', status: REJECTED });
      await expect(uc.execute('b', {})).rejects.toThrow(
        new ConflictException(
          'El paciente ya eligió una opción de este grupo: no se pueden añadir alternativas.',
        ),
      );
    },
  );

  it.each([ACCEPTED, COMPLETED])(
    'un plan suelto ya %s tampoco abre alternativas (409)',
    async (status) => {
      const { repo, uc } = setup();
      repo.seedPlan({ id: 'a', status });
      await expect(uc.execute('a', {})).rejects.toBeInstanceOf(
        ConflictException,
      );
    },
  );

  it('un plan cancelado sí sirve de base para una alternativa', async () => {
    const { repo, uc } = setup();
    repo.seedPlan({ id: 'a', status: CANCELLED });
    await expect(uc.execute('a', {})).resolves.toMatchObject({ status: DRAFT });
  });

  it('404 si el plan no es de esta clínica', async () => {
    const { uc } = setup();
    await expect(uc.execute('otro', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
