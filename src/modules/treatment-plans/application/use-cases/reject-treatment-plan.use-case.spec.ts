import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  TreatmentPlanItemStatus,
  TreatmentPlanRejectionReason,
  TreatmentPlanStatus,
} from '@prisma/client';
import { RejectTreatmentPlanUseCase } from './reject-treatment-plan.use-case';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';

const NOW = new Date('2026-10-16T15:00:00.000Z');
const { DRAFT, PRESENTED, ACCEPTED, REJECTED, COMPLETED, CANCELLED } =
  TreatmentPlanStatus;
const { PRICE, OTHER, OTHER_OPTION_ACCEPTED } = TreatmentPlanRejectionReason;

function setup() {
  const repo = new InMemoryTreatmentPlanRepository();
  return { repo, uc: new RejectTreatmentPlanUseCase(repo, () => NOW) };
}

describe('RejectTreatmentPlanUseCase (DX-040)', () => {
  it('un plan presentado pasa a REJECTED con motivo, nota recortada y hora', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: PRESENTED });
    const result = await uc.execute(plan.id, {
      reason: PRICE,
      note: '  Le pareció caro  ',
    });
    expect(result).toMatchObject({
      status: REJECTED,
      rejectedAt: NOW,
      rejectionReason: PRICE,
      rejectionNote: 'Le pareció caro',
    });
  });

  it('sin nota guarda null', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: PRESENTED });
    const result = await uc.execute(plan.id, { reason: PRICE, note: '   ' });
    expect(result.rejectionNote).toBeNull();
  });

  it('OTHER sin nota es 400 en español y no escribe', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: PRESENTED });
    await expect(uc.execute(plan.id, { reason: OTHER })).rejects.toThrow(
      new BadRequestException(
        'Con el motivo «Otro» describe en la nota por qué lo rechazó.',
      ),
    );
    expect(repo.stored(plan.id).status).toBe(PRESENTED);
  });

  it('OTHER_OPTION_ACCEPTED no lo elige el personal (400)', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: PRESENTED });
    await expect(
      uc.execute(plan.id, { reason: OTHER_OPTION_ACCEPTED }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([DRAFT, ACCEPTED, REJECTED, COMPLETED, CANCELLED])(
    'desde %s no se rechaza (409)',
    async (status) => {
      const { repo, uc } = setup();
      const plan = repo.seedPlan({ status });
      await expect(
        uc.execute(plan.id, { reason: PRICE }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.stored(plan.id).status).toBe(status);
    },
  );

  it('un plan con procedimientos realizados no se rechaza (409 en español)', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: PRESENTED });
    repo.seedItem({ planId: plan.id, status: TreatmentPlanItemStatus.DONE });
    await expect(uc.execute(plan.id, { reason: PRICE })).rejects.toThrow(
      new ConflictException(
        'El plan tiene procedimientos realizados: no se puede marcar como rechazado.',
      ),
    );
    expect(repo.stored(plan.id).status).toBe(PRESENTED);
  });

  it('un plan con abonos vivos no se rechaza (409 en español)', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: PRESENTED });
    repo.livePaymentPlanIds.add(plan.id);
    await expect(uc.execute(plan.id, { reason: PRICE })).rejects.toThrow(
      new ConflictException(
        'El plan tiene abonos registrados: no se puede marcar como rechazado. Anula los abonos o cancela el plan.',
      ),
    );
    expect(repo.stored(plan.id).status).toBe(PRESENTED);
  });

  it('rechazar una opción no toca a sus hermanas', async () => {
    const { repo, uc } = setup();
    repo.seedPlan({ id: 'a', status: PRESENTED, optionGroupId: 'a' });
    repo.seedPlan({ id: 'b', status: PRESENTED, optionGroupId: 'a' });
    await uc.execute('a', { reason: PRICE });
    expect(repo.stored('b').status).toBe(PRESENTED);
  });

  it('404 si el plan no es de esta clínica', async () => {
    const { uc } = setup();
    await expect(uc.execute('otro', { reason: PRICE })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('DX-109: rechazar cancela su plan de cuotas activo en la misma operación, con autor y motivo', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: PRESENTED });
    repo.activePaymentPlanIds.add(plan.id);
    await uc.execute(plan.id, { reason: PRICE }, 'user-1');
    expect(repo.paymentPlanCancellations).toEqual([
      {
        planId: plan.id,
        at: NOW,
        byId: 'user-1',
        reason: 'Se rechazó el plan de tratamiento.',
      },
    ]);
    expect(repo.activePaymentPlanIds.has(plan.id)).toBe(false);
  });

  it('DX-109: si el rechazo no procede (409), el plan de cuotas sigue activo', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: DRAFT });
    repo.activePaymentPlanIds.add(plan.id);
    await expect(
      uc.execute(plan.id, { reason: PRICE }, 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repo.activePaymentPlanIds.has(plan.id)).toBe(true);
    expect(repo.paymentPlanCancellations).toEqual([]);
  });
});
