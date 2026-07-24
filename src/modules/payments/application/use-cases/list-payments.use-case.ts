import { Inject, Injectable } from '@nestjs/common';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type { PaymentRepository } from '../../domain/ports/payment-repository.port';
import { Payment } from '../../domain/entities/payment.entity';

@Injectable()
export class ListPaymentsUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly repo: PaymentRepository,
  ) {}

  /**
   * Ordering (`paidAt` DESC) and the active/`deletedAt:null` filter are the
   * repository's responsibility (see `PrismaPaymentRepository` / the
   * in-memory fake) — this use case only forwards the plan id untouched.
   */
  async execute(treatmentPlanId: string): Promise<Payment[]> {
    return this.repo.listByPlan(treatmentPlanId);
  }
}
