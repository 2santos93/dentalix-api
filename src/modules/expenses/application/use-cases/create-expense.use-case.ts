import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { CURRENCY_WHITELIST } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import type { CurrencyWhitelist } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import type { ExpenseAttachment } from '../../domain/entities/expense.entity';
import {
  expenseRequestFingerprint,
  parseIdempotencyKey,
} from '../../domain/expense-idempotency';
import {
  IDEMPOTENCY_KEY_INVALID_MESSAGE,
  UNKNOWN_CURRENCY_MESSAGE,
  paymentCapDenial,
  toCents,
  validateAmount,
  validateDescription,
  validateDueDate,
  validateInvoiceDate,
  validateSupplier,
} from '../../domain/expense-rules';
import {
  EXPENSE_CASH_LINK,
  type ExpenseCashLink,
} from '../../domain/ports/expense-cash-link.port';
import {
  EXPENSE_REPOSITORY,
  type CreateExpensePaymentRepoInput,
  type ExpenseRepository,
} from '../../domain/ports/expense-repository.port';
import { ExpenseCategoryResolver } from '../expense-category-resolver';
import { ExpenseReceiptUploads } from '../expense-receipt-uploads';
import { EXPENSE_CLOCK, type ExpenseClock } from '../expense-tokens';
import { type ExpenseDetailView, detailViewOf } from '../expense-view';
import { guarded, rule } from '../guarded';
import {
  type IdempotencySignals,
  assertSameRequest,
} from '../idempotency-guard';
import { type PaymentCashRequest, planPaymentCash } from '../payment-cash-mode';

/**
 * Pago opcional en el mismo alta: fuera de caja (día por defecto, hoy en la
 * sede) o desde la caja abierta de quien registra (`fromCashSession`, R1).
 */
export interface InitialPaymentInput extends PaymentCashRequest {
  amount: number;
}

export interface CreateExpenseInput {
  locationId?: string;
  category: string;
  supplier?: string | null;
  description?: string | null;
  amount: number;
  currency: string;
  invoiceDate: string;
  dueDate?: string | null;
  payment?: InitialPaymentInput;
  attachmentUploadId?: string;
}

@Injectable()
export class CreateExpenseUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly repo: ExpenseRepository,
    private readonly categories: ExpenseCategoryResolver,
    private readonly receipts: ExpenseReceiptUploads,
    @Inject(CURRENCY_WHITELIST) private readonly whitelist: CurrencyWhitelist,
    @Inject(EXPENSE_CLOCK) private readonly clock: ExpenseClock,
    @Optional()
    @Inject(EXPENSE_CASH_LINK)
    private readonly cashLink?: ExpenseCashLink,
  ) {}

  /**
   * Orden: clave de idempotencia (una repetición devuelve el original sin
   * revalidar) → reglas del cuerpo → sede y su «hoy» → categoría → pago
   * inicial → soporte (lo último: es lo único con efectos fuera de la BD).
   * El pago inicial y el gasto entran en UNA transacción.
   */
  async execute(
    input: CreateExpenseInput,
    createdById: string,
    idempotencyHeader?: string,
    signals?: IdempotencySignals,
  ): Promise<ExpenseDetailView> {
    const key = parseIdempotencyKey(idempotencyHeader);
    if (key === null) {
      throw new BadRequestException(IDEMPOTENCY_KEY_INVALID_MESSAGE);
    }
    const fingerprint = key ? expenseRequestFingerprint(input) : undefined;
    return this.createIdempotent(input, createdById, key, fingerprint, signals);
  }

  /**
   * El alta con la clave ya leída y la huella de la petición que la trajo.
   * La salida de caja (`CreateCashOutflowUseCase`) entra por aquí con su
   * propia huella: mismo alta, mismas reglas, una sola transacción.
   */
  async createIdempotent(
    input: CreateExpenseInput,
    createdById: string,
    key: string | undefined,
    fingerprint: string | undefined,
    signals?: IdempotencySignals,
  ): Promise<ExpenseDetailView> {
    const now = this.clock();
    if (key) {
      const existing = await guarded(() =>
        this.repo.findByIdempotencyKey(key, now),
      );
      if (existing) {
        assertSameRequest(existing.fingerprint, fingerprint);
        if (signals) signals.replayed = true;
        return detailViewOf(this.repo, existing.detail);
      }
    }

    const amount = rule(() => validateAmount(input.amount));
    const currency = (input.currency ?? '').trim().toUpperCase();
    if (!(await this.whitelist.has(currency))) {
      throw new BadRequestException(UNKNOWN_CURRENCY_MESSAGE);
    }
    const supplier = rule(() => validateSupplier(input.supplier));
    const description = rule(() => validateDescription(input.description));
    const { locationId, today } = await guarded(() =>
      this.repo.resolveLocation(input.locationId, now),
    );
    const invoiceDate = rule(() =>
      validateInvoiceDate(input.invoiceDate, today),
    );
    const dueDate = rule(() => validateDueDate(input.dueDate, invoiceDate));
    const category = await this.categories.resolve(input.category);
    const payment = input.payment
      ? await this.initialPayment(input.payment, {
          amount,
          currency,
          today,
          createdById,
        })
      : undefined;

    const receipt = input.attachmentUploadId
      ? await this.receipts.complete(input.attachmentUploadId, createdById)
      : undefined;
    let result;
    try {
      result = await guarded(() =>
        this.repo.create(
          {
            locationId,
            category,
            supplier,
            description,
            amount,
            currency,
            invoiceDate,
            dueDate,
            attachment: receipt?.attachment ?? null,
            createdById,
            idempotencyKey: key,
            idempotencyFingerprint: fingerprint,
          },
          payment,
          now,
        ),
      );
    } catch (error) {
      // Si la BD ni responde, el objeto se conserva (la fila pudo crearse).
      if (receipt) {
        await this.discardUnused(receipt.attachment).catch(() => undefined);
      }
      throw error;
    }
    if (receipt) {
      // La otra petición de la misma clave (carrera) puede haber usado el
      // mismo objeto; solo se borra el que no quedó en ninguna fila.
      if (result.created) void this.receipts.discard(receipt.pendingKey);
      else await this.discardUnused(receipt.attachment);
    }
    if (!result.created) {
      assertSameRequest(result.fingerprint, fingerprint);
      if (signals) signals.replayed = true;
    }
    return detailViewOf(this.repo, result.detail);
  }

  private async initialPayment(
    payment: InitialPaymentInput,
    ctx: {
      amount: number;
      currency: string;
      today: string;
      createdById: string;
    },
  ): Promise<CreateExpensePaymentRepoInput> {
    const paymentAmount = rule(() => validateAmount(payment.amount));
    const denial = paymentCapDenial({
      amountCents: toCents(ctx.amount),
      liveCents: 0,
      paymentCents: toCents(paymentAmount),
      currency: ctx.currency,
    });
    if (denial) throw new BadRequestException(denial.message);
    const plan = await planPaymentCash(
      payment,
      ctx.today,
      this.repo,
      this.cashLink,
    );
    return {
      amount: paymentAmount,
      method: payment.method,
      paidOn: plan.paidOn,
      createdById: ctx.createdById,
      cashLink: plan.cashLink,
    };
  }

  /** Borra el soporte definitivo si ninguna fila lo usa. */
  private async discardUnused(attachment: ExpenseAttachment): Promise<void> {
    if (!(await this.repo.attachmentKeyInUse(attachment.key))) {
      await this.receipts.discard(attachment.key);
    }
  }
}
