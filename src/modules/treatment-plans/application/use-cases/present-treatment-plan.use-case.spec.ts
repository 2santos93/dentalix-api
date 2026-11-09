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

  it('DX-379: presentar fija la validez del presupuesto: hoy en la sede + los días del ajuste', async () => {
    const { repo, uc } = setup();
    repo.quoteValidityDays = 15;
    const plan = repo.seedPlan({ status: DRAFT });
    repo.seedItem({ planId: plan.id });

    const result = await uc.execute(plan.id);

    // 16 oct 2026 15:00 UTC = 11:00 en Caracas.
    expect(result).toMatchObject({
      quoteIssuedOn: '2026-10-16',
      quoteValidUntil: '2026-10-31',
    });
  });

  it('DX-379: presentar reemplaza la validez de un borrador ya impreso', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({
      status: DRAFT,
      quoteIssuedOn: '2026-09-01',
      quoteValidUntil: '2026-10-01',
    });
    repo.seedItem({ planId: plan.id });

    const result = await uc.execute(plan.id);

    expect(result).toMatchObject({
      quoteIssuedOn: '2026-10-16',
      quoteValidUntil: '2026-11-15',
    });
  });

  it('DX-379: a las 23:30 de Caracas (ya el día siguiente en UTC) la validez cuenta desde el día de la sede', async () => {
    const repo = new InMemoryTreatmentPlanRepository();
    const uc = new PresentTreatmentPlanUseCase(
      repo,
      () => new Date('2026-10-17T03:30:00.000Z'),
    );
    const plan = repo.seedPlan({ status: DRAFT });
    repo.seedItem({ planId: plan.id });

    expect(await uc.execute(plan.id)).toMatchObject({
      quoteIssuedOn: '2026-10-16',
      quoteValidUntil: '2026-11-15',
    });
  });

  it('un plan rechazado por no tener ítems no guarda validez', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: DRAFT });
    await expect(uc.execute(plan.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.stored(plan.id).quoteIssuedOn).toBeNull();
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
