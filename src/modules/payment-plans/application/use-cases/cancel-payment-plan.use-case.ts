import type { LockActor } from '../../../financial-lock/domain/financial-lock';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PAYMENT_PLAN_REPOSITORY } from '../../domain/ports/payment-plan-repository.port';
import type { PaymentPlanRepository } from '../../domain/ports/payment-plan-repository.port';
import {
  CLOCK,
  NO_ACTIVE_PAYMENT_PLAN_MESSAGE,
  type Clock,
} from './get-payment-plan.use-case';

export interface CancelPaymentPlanInput {
  /** Quién cancela: el usuario del token, nunca el cliente. */
  byId: string;
  /** Motivo ya recortado y validado (3–300) por el DTO. */
  reason: string;
  /** DX-091: quién cancela y su motivo para un período cerrado. */
  lockActor?: LockActor | null;
}

@Injectable()
export class CancelPaymentPlanUseCase {
  constructor(
    @Inject(PAYMENT_PLAN_REPOSITORY)
    private readonly repo: PaymentPlanRepository,
    @Inject(CLOCK)
    private readonly now: Clock,
  ) {}

  /**
   * DX-092 (SEC-029): cancelar deja el plan de cuotas en CANCELLED con quién,
   * cuándo (reloj del servidor) y por qué, como la anulación de un abono.
   */
  async execute(
    treatmentPlanId: string,
    input: CancelPaymentPlanInput,
  ): Promise<void> {
    const active = await this.repo.findActiveByPlan(treatmentPlanId);
    if (!active) {
      throw new NotFoundException(NO_ACTIVE_PAYMENT_PLAN_MESSAGE);
    }
    // cancel() is a check-and-set; a concurrent cancel that already won
    // returns false, which we treat as "already gone" -> NotFound.
    const cancelled = await this.repo.cancel(
      active.id,
      { byId: input.byId, at: this.now(), reason: input.reason },
      input.lockActor ?? null,
    );
    if (!cancelled) {
      throw new NotFoundException(NO_ACTIVE_PAYMENT_PLAN_MESSAGE);
    }
  }
}
