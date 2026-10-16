import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import { PresentTreatmentPlanUseCase } from './present-treatment-plan.use-case';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';

const NOW = new Date('2026-10-16T15:00:00.000Z');
const { DRAFT, PRESENTED, ACCEPTED, REJECTED, COMPLETED, CANCELLED } =
  TreatmentPlanStatus;

function setup() {
  const repo = new InMemoryTreatmentPlanRepository();
  repo.locationId = 'sede-norte';
  return { repo, uc: new PresentTreatmentPlanUseCase(repo, () => NOW) };
}

describe('PresentTreatmentPlanUseCase (DX-040)', () => {
  it('un borrador con ítems pasa a PRESENTED con la hora del servidor y la sede', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: DRAFT });
    repo.seedItem({ planId: plan.id });

    const result = await uc.execute(plan.id);

    expect(result).toMatchObject({
      status: PRESENTED,
      presentedAt: NOW,
      presentedLocationId: 'sede-norte',
    });
  });

  it('un plan sin ítems no se presenta (400)', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: DRAFT });
    await expect(uc.execute(plan.id)).rejects.toThrow(
      new BadRequestException(
        'El plan no tiene ítems: agrega al menos un procedimiento antes de presentarlo.',
      ),
    );
    expect(repo.stored(plan.id).status).toBe(DRAFT);
  });

  it.each([PRESENTED, ACCEPTED, REJECTED, COMPLETED, CANCELLED])(
    'desde %s no se presenta (409)',
    async (status) => {
      const { repo, uc } = setup();
      const plan = repo.seedPlan({ status });
      repo.seedItem({ planId: plan.id });
      await expect(uc.execute(plan.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repo.stored(plan.id).status).toBe(status);
    },
  );

  it('404 si el plan no es de esta clínica', async () => {
    const { uc } = setup();
    await expect(uc.execute('otro')).rejects.toBeInstanceOf(NotFoundException);
  });
});
