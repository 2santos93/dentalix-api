import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { IDEMPOTENCY_KEY_INVALID_MESSAGE } from '../../../../shared/validation/idempotency-key';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import { PAYMENT_CLOCK, type PaymentClock } from './void-payment.use-case';
import type { PaymentRepository } from '../../domain/ports/payment-repository.port';
import { Payment } from '../../domain/entities/payment.entity';
import {
  IDEMPOTENCY_KEY_REUSED_MESSAGE,
  isSameRequest,
  paymentRequestFingerprint,
  paymentTargetKey,
} from '../../domain/idempotency';
import {
  OPENING_BALANCE_NOT_FOUND_MESSAGE,
  OPENING_BALANCE_PAID_MESSAGE,
  openingBalanceCurrencyMessage,
  openingBalanceOverpaidMessage,
} from '../../domain/opening-balance-payment';
import { CURRENCY_WHITELIST } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import type { CurrencyWhitelist } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import {
  UUID_RE,
  isFinitePositive,
  assertPaidAtWindow,
  normalizePaidAt,
  type RecordPaymentInput,
} from './record-payment.use-case';
import { PaymentMethodGate } from '../payment-method-gate';
import { PaymentProofs, attachmentOf } from '../payment-proofs';
import { toCents } from '../../../../shared/money/money';

/**
 * Abono contra el saldo migrado de un paciente (DX-262, revisión C1): el
 * mismo abono que a un plan —recibo de caja numerado por sede (DX-136), caja
 * por turno (DX-027), idempotencia (DX-109), anulación (SEC-013)— pero su
 * destino es el saldo, no un plan. El paciente sale del saldo (nunca del
 * cliente), en la moneda del saldo y sin pasarse de lo pendiente; el
 * repositorio lo repite con el saldo bloqueado en la transacción del INSERT.
 */
@Injectable()
export class RecordOpeningBalancePaymentUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly repo: PaymentRepository,
    @Inject(CURRENCY_WHITELIST)
    private readonly whitelist: CurrencyWhitelist,
    // DX-377: medio del catálogo, referencia y aviso de referencia repetida.
    private readonly paymentMethodGate: PaymentMethodGate,
    // DX-389: el comprobante del cobro (subida directa ya hecha).
    private readonly proofs: PaymentProofs,
    // DX-054: la fecha del abono no puede ir más de 24 h por delante.
    @Inject(PAYMENT_CLOCK)
    private readonly now: PaymentClock,
  ) {}

  async execute(
    openingBalanceId: string,
    input: RecordPaymentInput,
    createdById?: string,
    idempotencyKey?: string,
  ): Promise<Payment> {
    const key = idempotencyKey?.trim() ? idempotencyKey.trim() : undefined;
    const target = paymentTargetKey({
      treatmentPlanId: null,
      openingBalanceId,
    });
    const requestFingerprint = paymentRequestFingerprint(target, input);
    if (key !== undefined) {
      if (!UUID_RE.test(key)) {
        throw new BadRequestException(IDEMPOTENCY_KEY_INVALID_MESSAGE);
      }
      const existing = await this.repo.findByIdempotencyKey(key);
      if (existing) {
        if (!isSameRequest(existing, target, requestFingerprint)) {
          throw new UnprocessableEntityException(
            IDEMPOTENCY_KEY_REUSED_MESSAGE,
          );
        }
        return existing.payment;
      }
    }

    if (!isFinitePositive(input.amount)) {
      throw new BadRequestException('amount must be a finite number > 0');
    }
    if (!input.currency || input.currency.trim() === '') {
      throw new BadRequestException('currency is required');
    }
    const currency = input.currency.trim().toUpperCase();
    if (!(await this.whitelist.has(currency))) {
      throw new BadRequestException(`Unknown currency: ${currency}`);
    }
    const paidAt = normalizePaidAt(input.paidAt);
    await assertPaidAtWindow(this.repo, paidAt, this.now());

    const balance = await this.repo.findOpeningBalance(openingBalanceId);
    if (!balance) {
      throw new NotFoundException(OPENING_BALANCE_NOT_FOUND_MESSAGE);
    }
    if (balance.currency !== currency) {
      throw new BadRequestException(
        openingBalanceCurrencyMessage(balance.currency),
      );
    }
    // Atajo con un 400 limpio; la comprobación que cuenta la repite el
    // repositorio con el saldo bloqueado (dos cobros a la vez).
    const pendingCents = toCents(balance.amount) - toCents(balance.paid);
    if (toCents(input.amount) > pendingCents) {
      throw new BadRequestException(
        pendingCents <= 0
          ? OPENING_BALANCE_PAID_MESSAGE
          : openingBalanceOverpaidMessage(
              pendingCents / 100,
              currency,
              await this.repo.locationFormat(balance.locationId),
            ),
      );
    }

    const payMethod = await this.paymentMethodGate.resolve(input, paidAt, {
      amount: input.amount,
      currency,
    });
    const proof = await this.proofs.complete(
      payMethod.proofUploadId,
      createdById,
    );
    let payment: Payment;
    try {
      payment = await this.repo.create({
        treatmentPlanId: null,
        openingBalanceId,
        patientId: balance.patientId,
        amount: input.amount,
        currency,
        paidAt,
        method: payMethod.method,
        paymentMethodId: payMethod.paymentMethodId,
        reference: payMethod.reference,
        referenceNormalized: payMethod.referenceNormalized,
        duplicateReferenceReason: payMethod.duplicateReferenceReason,
        adjustments: payMethod.adjustments,
        proof: attachmentOf(proof),
        notes: input.notes,
        createdById,
        idempotencyKey: key,
        requestFingerprint: key === undefined ? undefined : requestFingerprint,
        // El saldo del recibo lo calcula el repositorio con el saldo bloqueado.
        receiptPlanBalance: null,
        // DX-051 (R1): un abono a un saldo migrado no se imputa a ítems.
        planAmount: null,
        // Un saldo migrado se abona en su moneda: no hay tasa que congelar.
        frozenRate: null,
      });
    } catch (error) {
      await this.proofs.settle([proof], false);
      throw error;
    }
    await this.proofs.settle([proof], true);
    return { ...payment, duplicateReferenceOf: payMethod.duplicateReferenceOf };
  }
}
