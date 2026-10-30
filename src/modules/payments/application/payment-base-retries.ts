import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ConvertAmountUseCase,
  type AmountConverter,
} from '../../exchange/application/use-cases/convert-amount.use-case';
import {
  PAYMENT_BASE_BACKLOG_HOURS,
  paymentBaseRetryDelayMs,
  type PaymentBaseRetryReason,
} from '../domain/payment-base-retry';
import {
  exchangeRateStatus,
  type PaymentRateState,
} from '../domain/payment-exchange-rate';
import {
  PAYMENT_BASE_RETRY_REPOSITORY,
  type PaymentBaseBacklog,
  type PaymentBaseRetryCandidate,
  type PaymentBaseRetryRepository,
} from '../domain/ports/payment-base-retry-repository.port';
import {
  PLAN_ALLOCATION_REPOSITORY,
  type PlanAllocationRepository,
} from '../domain/ports/plan-allocation-repository.port';
import { errorName } from './payment-in-plan-currency';
import { freezePaymentRate, paymentBaseAmount } from './payment-exchange-rate';

/** Lo que hizo una pasada de reintentos en la clínica del contexto. */
export interface RetryPassResult {
  /** Abonos que ya tienen su tasa y su base (o ya no las necesitan). */
  resolved: number;
  /** Siguen sin tasa: aplazados con el backoff. */
  withoutRate: number;
  /** Fallaron por otra cosa: aplazados con el mismo backoff. */
  failed: number;
}

type AttemptOutcome = 'RESOLVED' | PaymentBaseRetryReason;

/**
 * DX-380 (OPS-045): reintento escalonado de los abonos que se quedaron sin
 * base de imputación (DX-051) o sin su tasa congelada (DX-375). En la clínica
 * del contexto, toma los reintentos vencidos (el que venció antes primero),
 * congela la tasa del abono si la espera, crea su base si le falta y, si no
 * puede, lo aplaza 1 min → 5 → 30 → 2 h → 24 h. Un abono atascado no tapa a
 * los demás: va al final de la cola. Cotiza FUERA de transacción, con un
 * convertidor por pasada (un día se pide una vez); detrás, la caché negativa
 * y los presupuestos de SEC-054 acotan las llamadas al proveedor.
 */
@Injectable()
export class PaymentBaseRetries {
  private readonly logger = new Logger('PaymentAllocations');

  constructor(
    @Inject(PAYMENT_BASE_RETRY_REPOSITORY)
    private readonly retries: PaymentBaseRetryRepository,
    @Inject(PLAN_ALLOCATION_REPOSITORY)
    private readonly allocations: PlanAllocationRepository,
    private readonly convertAmount: ConvertAmountUseCase,
  ) {}

  /** Clínicas con reintentos vencidos o planes por repartir (sin tenant). */
  dueTenantIds(): Promise<string[]> {
    return this.retries.dueTenantIds();
  }

  /** Hasta `limit` reintentos vencidos de la clínica del contexto. */
  async retryDue(limit: number): Promise<RetryPassResult> {
    const result: RetryPassResult = { resolved: 0, withoutRate: 0, failed: 0 };
    const convert = this.convertAmount.memoized();
    for (const candidate of await this.retries.due(limit)) {
      let outcome: AttemptOutcome;
      try {
        outcome = await this.attempt(convert, candidate);
      } catch (error) {
        this.logger.warn({
          event: 'payments.allocation_retry_failed',
          paymentId: candidate.paymentId,
          attempts: candidate.attempts + 1,
          error: errorName(error),
        });
        outcome = 'ERROR';
      }
      if (outcome === 'RESOLVED') {
        await this.retries.resolve(candidate.paymentId);
        result.resolved += 1;
        continue;
      }
      const attempts = candidate.attempts + 1;
      await this.retries.postpone(candidate.paymentId, {
        attempts,
        reason: outcome,
        delayMs: paymentBaseRetryDelayMs(attempts),
      });
      if (outcome === 'NO_RATE') result.withoutRate += 1;
      else result.failed += 1;
    }
    return result;
  }

  /**
   * La clínica del contexto registró o corrigió una tasa, o cambió de
   * fuente: sus abonos aplazados se intentan en el barrido siguiente.
   */
  wake(): Promise<number> {
    return this.retries.wake();
  }

  /** Abonos sin base desde hace más de 24 h (aviso al ADMIN). */
  backlog(): Promise<PaymentBaseBacklog> {
    return this.retries.backlog(PAYMENT_BASE_BACKLOG_HOURS);
  }

  /**
   * Un intento: primero la tasa (la base nace de la tasa congelada), luego la
   * base. «Sin tasa» (también el proveedor caído o por tiempo agotado) es
   * `NO_RATE`; cualquier otro fallo se propaga y cuenta como `ERROR`.
   */
  private async attempt(
    convert: AmountConverter,
    payment: PaymentBaseRetryCandidate,
  ): Promise<AttemptOutcome> {
    if (!payment.live) return 'RESOLVED';
    let state: PaymentRateState = payment;
    const status = exchangeRateStatus(payment);
    if (status === 'MISSING' || status === 'LEGACY') {
      const rate = await freezePaymentRate(convert, payment);
      const frozen = await this.allocations.freezeRate(
        payment.paymentId,
        payment.targetCurrency,
        rate,
      );
      if (payment.currency !== payment.targetCurrency && !frozen) {
        return 'NO_RATE';
      }
      state = {
        currency: payment.currency,
        exchangeRateCurrency: payment.targetCurrency,
        frozenRate: frozen ? rate : null,
      };
    }
    if (payment.planCurrency === null || payment.hasBase) return 'RESOLVED';
    const amount = await paymentBaseAmount(
      convert,
      { ...state, amount: payment.amount, paidOn: payment.paidOn },
      payment.planCurrency,
    );
    if (amount === null) return 'NO_RATE';
    // `false`: la base ya existe (otra pasada o el alta), el abono se anuló o
    // su plan cambió de moneda. El intento siguiente lo relee.
    const created = await this.allocations.ensureBase(
      payment.paymentId,
      amount,
      payment.planCurrency,
      payment.paidOn,
    );
    return created ? 'RESOLVED' : 'ERROR';
  }
}
