import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  expensePaymentFingerprint,
  parseIdempotencyKey,
} from '../../domain/expense-idempotency';
import {
  EXPENSE_NOT_FOUND_MESSAGE,
  EXPENSE_VOIDED_MESSAGE,
  IDEMPOTENCY_KEY_INVALID_MESSAGE,
  validateAmount,
} from '../../domain/expense-rules';
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
import {
  type IdempotencySignals,
  assertSamePayment,
} from '../idempotency-guard';
import { type PaymentCashRequest, planPaymentCash } from '../payment-cash-mode';

/**
 * Pago fuera de caja (día por defecto, hoy en la sede) o desde la caja
 * abierta de quien paga en la sede del gasto (`fromCashSession`, R1).
 */
export interface AddExpensePaymentInput extends PaymentCashRequest {
  amount: number;
}

@Injectable()
export class AddExpensePaymentUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly repo: ExpenseRepository,
    @Inject(EXPENSE_CLOCK) private readonly clock: ExpenseClock,
    @Optional()
    @Inject(EXPENSE_CASH_LINK)
    private readonly cashLink?: ExpenseCashLink,
  ) {}

  /**
   * Registra un pago (total o parcial) de un gasto. El tope (Σ vivos ≤
   * importe) lo decide el repositorio con el gasto bloqueado. Con
   * Idempotency-Key, repetir la misma petición devuelve el gasto como quedó.
   */
  async execute(
    expenseId: string,
    input: AddExpensePaymentInput,
    createdById: string,
    idempotencyHeader?: string,
    signals?: IdempotencySignals,
  ): Promise<ExpenseDetailView> {
    const key = parseIdempotencyKey(idempotencyHeader);
    if (key === null) {
      throw new BadRequestException(IDEMPOTENCY_KEY_INVALID_MESSAGE);
    }
    const fingerprint = key
      ? expensePaymentFingerprint(expenseId, input)
      : undefined;
    const now = this.clock();
    if (key) {
      const existing = await guarded(() =>
        this.repo.findPaymentByIdempotencyKey(key),
      );
      if (existing) {
        assertSamePayment(existing, expenseId, fingerprint);
        const detail = await this.repo.findById(existing.expenseId, now);
        if (detail) {
          if (signals) signals.replayed = true;
          return detailViewOf(this.repo, detail);
        }
      }
    }

    const current = await this.repo.findById(expenseId, now);
    if (!current) throw new NotFoundException(EXPENSE_NOT_FOUND_MESSAGE);
    if (current.voidedAt) throw new ConflictException(EXPENSE_VOIDED_MESSAGE);

    const amount = rule(() => validateAmount(input.amount));
    const today = await this.repo.locationToday(current.locationId, now);
    // Desde la caja: efectivo, hoy y la caja abierta de quien paga en la sede
    // del gasto. Fuera de caja, el efectivo no se acepta si la clínica lo
    // registra siempre en una caja abierta.
    const plan = await planPaymentCash(input, today, this.repo, this.cashLink);

    const result = await guarded(() =>
      this.repo.addPayment(
        expenseId,
        {
          amount,
          method: input.method,
          paidOn: plan.paidOn,
          createdById,
          cashLink: plan.cashLink,
          idempotencyKey: key,
          idempotencyFingerprint: fingerprint,
        },
        now,
      ),
    );
    if (!result.created) {
      assertSamePayment(
        { expenseId: result.detail.id, fingerprint: result.fingerprint },
        expenseId,
        fingerprint,
      );
      if (signals) signals.replayed = true;
    }
    return detailViewOf(this.repo, result.detail);
  }
}
