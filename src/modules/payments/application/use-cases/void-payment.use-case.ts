import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type { PaymentRepository } from '../../domain/ports/payment-repository.port';

@Injectable()
export class VoidPaymentUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly repo: PaymentRepository,
  ) {}

  async execute(id: string): Promise<void> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      throw new NotFoundException('Payment not found');
    }

    // Soft-delete only — never a hard delete on a domain table. A voided
    // payment is a financial record too: it must remain queryable for
    // audit, just excluded from active lists/balances/totals via
    // `deletedAt: null`.
    await this.repo.softDelete(id);
  }
}
