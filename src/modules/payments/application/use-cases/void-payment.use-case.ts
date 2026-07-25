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
    // Soft-delete only — never a hard delete on a domain table. A voided
    // payment is a financial record too: it must remain queryable for
    // audit, just excluded from active lists/balances/totals via
    // `deletedAt: null`.
    //
    // A single atomic call, not a `findById` precheck followed by a separate
    // `softDelete` — that two-step (each its own transaction) let two
    // concurrent void requests for the same payment both observe "not yet
    // voided" and both proceed (TOCTOU race). `repo.softDelete` now does the
    // find-and-mark in one atomic step and reports whether THIS call was the
    // one that voided it; `false` means already-voided or nonexistent,
    // which — same as before — is a 404.
    const voided = await this.repo.softDelete(id);
    if (!voided) {
      throw new NotFoundException('Payment not found');
    }
  }
}
