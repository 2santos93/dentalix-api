import { Inject, Injectable, Optional } from '@nestjs/common';
import { validateVoidReason } from '../../domain/expense-rules';
import {
  EXPENSE_CASH_LINK,
  type ExpenseCashLink,
} from '../../domain/ports/expense-cash-link.port';
import {
  EXPENSE_REPOSITORY,
  type ExpenseRepository,
} from '../../domain/ports/expense-repository.port';
import { EXPENSE_CLOCK, type ExpenseClock } from '../expense-tokens';
import { type ExpenseDetailView, detailViewOf } from '../expense-view';
import { guarded, rule } from '../guarded';

@Injectable()
export class VoidExpensePaymentUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly repo: ExpenseRepository,
    @Inject(EXPENSE_CLOCK) private readonly clock: ExpenseClock,
    @Optional()
    @Inject(EXPENSE_CASH_LINK)
    private readonly cashLink?: ExpenseCashLink,
  ) {}

  /** Anula un pago (una vez); el gasto vuelve a deber ese importe. */
  async execute(
    expenseId: string,
    paymentId: string,
    reason: string | undefined,
    voidedById: string,
  ): Promise<ExpenseDetailView> {
    const trimmed = rule(() => validateVoidReason(reason));
    const detail = await guarded(() =>
      this.repo.voidPayment(
        expenseId,
        paymentId,
        trimmed,
        voidedById,
        this.clock(),
        this.cashLink,
      ),
    );
    return detailViewOf(this.repo, detail);
  }
}
