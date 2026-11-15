import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PAYMENT_PLAN_REPOSITORY } from '../../domain/ports/payment-plan-repository.port';
import type { PaymentPlanRepository } from '../../domain/ports/payment-plan-repository.port';

@Injectable()
export class CancelPaymentPlanUseCase {
  constructor(
    @Inject(PAYMENT_PLAN_REPOSITORY)
    private readonly repo: PaymentPlanRepository,
  ) {}

  async execute(treatmentPlanId: string): Promise<void> {
    const active = await this.repo.findActiveByPlan(treatmentPlanId);
    if (!active) {
      throw new NotFoundException(
        'Este plan de tratamiento no tiene un plan de cuotas activo.',
      );
    }
    // cancel() is a check-and-set; a concurrent cancel that already won
    // returns false, which we treat as "already gone" -> NotFound.
    const cancelled = await this.repo.cancel(active.id);
    if (!cancelled) {
      throw new NotFoundException(
        'Este plan de tratamiento no tiene un plan de cuotas activo.',
      );
    }
  }
}
