import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PaymentMethod } from '@prisma/client';
import {
  expensePaymentFingerprint,
  parseIdempotencyKey,
} from '../../domain/expense-idempotency';
import {
  CASH_SESSION_REQUIRED_MESSAGE,
  EXPENSE_NOT_FOUND_MESSAGE,
  EXPENSE_VOIDED_MESSAGE,
  IDEMPOTENCY_KEY_INVALID_MESSAGE,
  IDEMPOTENCY_KEY_REUSED_MESSAGE,
  validateAmount,
  validatePaidOn,
} from '../../domain/expense-rules';
import {
  EXPENSE_REPOSITORY,
  type ExpenseRepository,
} from '../../domain/ports/expense-repository.port';
import { EXPENSE_CLOCK, type ExpenseClock } from '../expense-tokens';
import { type ExpenseDetailView, detailViewOf } from '../expense-view';
import { guarded, rule } from '../guarded';

export interface AddExpensePaymentInput {
  amount: number;
  method: PaymentMethod;
  /** Día del pago; por defecto, hoy en la sede. */
  paidOn?: string;
}

@Injectable()
export class AddExpensePaymentUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly repo: ExpenseRepository,
    @Inject(EXPENSE_CLOCK) private readonly clock: ExpenseClock,
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
      const existing = await this.repo.findPaymentByIdempotencyKey(key);
      if (existing) {
        this.assertSame(existing, expenseId, fingerprint);
        const detail = await this.repo.findById(existing.expenseId, now);
        if (detail) return detailViewOf(this.repo, detail);
      }
    }

    const current = await this.repo.findById(expenseId, now);
    if (!current) throw new NotFoundException(EXPENSE_NOT_FOUND_MESSAGE);
    if (current.voidedAt) throw new ConflictException(EXPENSE_VOIDED_MESSAGE);

    const amount = rule(() => validateAmount(input.amount));
    const today = await this.repo.locationToday(current.locationId, now);
    const paidOn =
      input.paidOn === undefined
        ? today
        : rule(() => validatePaidOn(input.paidOn, today));
    // Con la clínica en «el efectivo va a una caja abierta», un pago en
    // efectivo fuera de caja no se acepta.
    if (
      input.method === 'CASH' &&
      (await this.repo.cashRequiresOpenSession())
    ) {
      throw new ConflictException(CASH_SESSION_REQUIRED_MESSAGE);
    }

    const result = await guarded(() =>
      this.repo.addPayment(
        expenseId,
        {
          amount,
          method: input.method,
          paidOn,
          createdById,
          idempotencyKey: key,
          idempotencyFingerprint: fingerprint,
        },
        now,
      ),
    );
    if (!result.created) {
      this.assertSame(
        { expenseId: result.detail.id, fingerprint: result.fingerprint },
        expenseId,
        fingerprint,
      );
    }
    return detailViewOf(this.repo, result.detail);
  }

  private assertSame(
    stored: { expenseId: string; fingerprint: string | null },
    expenseId: string,
    fingerprint: string | undefined,
  ): void {
    if (
      stored.expenseId !== expenseId ||
      (stored.fingerprint !== null &&
        fingerprint !== undefined &&
        stored.fingerprint !== fingerprint)
    ) {
      throw new UnprocessableEntityException(IDEMPOTENCY_KEY_REUSED_MESSAGE);
    }
  }
}
