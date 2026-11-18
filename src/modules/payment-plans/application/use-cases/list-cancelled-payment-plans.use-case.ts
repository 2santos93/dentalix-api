import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CancelledPaymentPlan } from '../../domain/entities/payment-plan.entity';
import { PAYMENT_PLAN_REPOSITORY } from '../../domain/ports/payment-plan-repository.port';
import type { PaymentPlanRepository } from '../../domain/ports/payment-plan-repository.port';
import { TREATMENT_PLAN_NOT_FOUND_MESSAGE } from './get-payment-plan.use-case';

/**
 * DX-123 (O-2): los planes de cuotas cancelados de un plan de tratamiento,
 * con quién, cuándo y por qué. Antes un plan cancelado desaparecía de la
 * ficha sin rastro visible. 404 si el plan de tratamiento no existe o es de
 * otra clínica; lista vacía si nunca se canceló ninguno.
 */
@Injectable()
export class ListCancelledPaymentPlansUseCase {
  constructor(
    @Inject(PAYMENT_PLAN_REPOSITORY)
    private readonly repo: PaymentPlanRepository,
  ) {}

  async execute(treatmentPlanId: string): Promise<CancelledPaymentPlan[]> {
    if (!(await this.repo.treatmentPlanExists(treatmentPlanId))) {
      throw new NotFoundException(TREATMENT_PLAN_NOT_FOUND_MESSAGE);
    }
    return this.repo.findCancelledByPlan(treatmentPlanId);
  }
}
