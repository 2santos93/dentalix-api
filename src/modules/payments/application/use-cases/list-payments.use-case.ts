import { Inject, Injectable } from '@nestjs/common';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type { PaymentRepository } from '../../domain/ports/payment-repository.port';
import { Payment } from '../../domain/entities/payment.entity';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';

@Injectable()
export class ListPaymentsUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly repo: PaymentRepository,
    private readonly getTreatmentPlan: GetTreatmentPlanUseCase,
  ) {}

  /**
   * Ordering (`paidAt` DESC) and the active/`deletedAt:null` filter are the
   * repository's responsibility (see `PrismaPaymentRepository` / the
   * in-memory fake).
   *
   * `GetTreatmentPlanUseCase` is resolved FIRST (same dependency
   * `GetPlanBalanceUseCase` uses) so a nonexistent/cross-tenant plan id
   * throws `NotFoundException` -> 404, matching GET .../balance, instead of
   * silently forwarding to `repo.listByPlan` and returning `200 []` (RLS
   * makes "cross-tenant" and "absent" indistinguishable either way).
   */
  async execute(treatmentPlanId: string): Promise<Payment[]> {
    await this.getTreatmentPlan.execute(treatmentPlanId);
    return this.repo.listByPlan(treatmentPlanId);
  }
}
