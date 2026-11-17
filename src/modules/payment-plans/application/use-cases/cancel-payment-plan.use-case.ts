import type { LockActor } from '../../../financial-lock/domain/financial-lock';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PAYMENT_PLAN_REPOSITORY } from '../../domain/ports/payment-plan-repository.port';
import type { PaymentPlanRepository } from '../../domain/ports/payment-plan-repository.port';

@Injectable()
export class CancelPaymentPlanUseCase {
  constructor(
    @Inject(PAYMENT_PLAN_REPOSITORY)
    private readonly repo: PaymentPlanRepository,
  ) {}

  /** DX-091: `lockActor`, quién cancela y su motivo para un período cerrado. */
  async execute(
    treatmentPlanId: string,
    lockActor?: LockActor | null,
  ): Promise<void> {
    const active = await this.repo.findActiveByPlan(treatmentPlanId);
    if (!active) {
      throw new NotFoundException(
        'Este plan de tratamiento no tiene un plan de cuotas activo.',
      );
    }
    // cancel() is a check-and-set; a concurrent cancel that already won
    // returns false, which we treat as "already gone" -> NotFound.
    const cancelled = await this.repo.cancel(active.id, lockActor ?? null);
    if (!cancelled) {
      throw new NotFoundException(
        'Este plan de tratamiento no tiene un plan de cuotas activo.',
      );
    }
  }
}
