import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
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
  openingBalanceCurrencyMessage,
  openingBalanceOverpaidMessage,
} from '../../domain/opening-balance-payment';
import { CURRENCY_WHITELIST } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import type { CurrencyWhitelist } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import {
  UUID_RE,
  isFinitePositive,
  normalizePaidAt,
  type RecordPaymentInput,
} from './record-payment.use-case';

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
        throw new BadRequestException('Idempotency-Key must be a UUID');
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
    const pendingCents =
      Math.round(balance.amount * 100) - Math.round(balance.paid * 100);
    if (Math.round(input.amount * 100) > pendingCents) {
      throw new BadRequestException(
        openingBalanceOverpaidMessage(pendingCents / 100, currency),
      );
    }

    return this.repo.create({
      treatmentPlanId: null,
      openingBalanceId,
      patientId: balance.patientId,
      amount: input.amount,
      currency,
      paidAt,
      method: input.method,
      notes: input.notes,
      createdById,
      idempotencyKey: key,
      requestFingerprint: key === undefined ? undefined : requestFingerprint,
      // El saldo del recibo lo calcula el repositorio con el saldo bloqueado.
      receiptPlanBalance: null,
      // DX-051 (R1): un abono a un saldo migrado no se imputa a ítems.
      planAmount: null,
    });
  }
}
