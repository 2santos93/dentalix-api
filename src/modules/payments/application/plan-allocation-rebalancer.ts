import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConvertAmountUseCase } from '../../exchange/application/use-cases/convert-amount.use-case';
import { respreadSurplus } from '../domain/allocation-rules';
import {
  PLAN_ALLOCATION_REPOSITORY,
  type PlanAllocationRepository,
} from '../domain/ports/plan-allocation-repository.port';
import { errorName } from './payment-in-plan-currency';
import { freezePaymentRate, paymentBaseAmount } from './payment-exchange-rate';
import type { FrozenExchangeRate } from '../domain/payment-exchange-rate';

export interface DrainOptions {
  /** Autor de las filas AUTO; `null` en el barrido. */
  actorId: string | null;
  /** El plan de la ruta: se drena primero. */
  preferPlanId?: string;
  /** El abono de la ruta (anulación): sin `preferPlanId`, se drena primero su plan. */
  preferPaymentId?: string;
  /** Planes como mucho; sin él, todos los que tenían solicitudes al empezar. */
  limit?: number;
}

/**
 * Reparto automático de sobrantes (DX-051, spec R5, R9): para un plan, los
 * sobrantes de los abonos no fijados llenan lo libre de sus ítems (abono más
 * antiguo primero; DONE y luego ACCEPTED). Lo usan el interceptor tras cada
 * escritura, el barrido de cada minuto, la reasignación y el backfill. Todo en
 * el tenant del contexto.
 */
@Injectable()
export class PlanAllocationRebalancer {
  private readonly logger = new Logger('PaymentAllocations');

  constructor(
    @Inject(PLAN_ALLOCATION_REPOSITORY)
    private readonly repo: PlanAllocationRepository,
    private readonly convertAmount: ConvertAmountUseCase,
  ) {}

  /**
   * Reparte el plan en UNA transacción (bloqueos de R6). Con `dryRun` calcula,
   * devuelve y deshace (R17 `--dry-run`).
   */
  async rebalancePlan(
    planId: string,
    actorId: string | null,
    opts: { dryRun?: boolean } = {},
  ): Promise<{ allocatedCents: number }> {
    const allocatedCents = await this.repo.rebalance(
      planId,
      { actorId, dryRun: opts.dryRun ?? false },
      ({ donors, items }) => respreadSurplus(donors, items),
    );
    return { allocatedCents };
  }

  /**
   * Drena la cola del tenant actual: el plan preferido primero y como mucho
   * `limit` planes, cada uno una vez. Nunca lanza: un plan que falla queda en
   * la cola (lo reintenta el barrido) y se registra una vez. Devuelve los
   * planes repartidos.
   */
  async drainPending(opts: DrainOptions): Promise<number> {
    const preferPlanId =
      opts.preferPlanId ??
      (await this.planOfRoutePayment(opts.preferPaymentId));
    let planIds: string[];
    try {
      planIds = await this.repo.pendingPlanIds(preferPlanId, opts.limit);
    } catch (error) {
      this.logger.warn({
        event: 'payments.allocation_drain_failed',
        error: errorName(error),
      });
      return 0;
    }
    let drained = 0;
    for (const planId of planIds) {
      try {
        await this.repo.rebalance(
          planId,
          { actorId: opts.actorId, onlyIfRequested: true },
          ({ donors, items }) => respreadSurplus(donors, items),
        );
        drained += 1;
      } catch (error) {
        this.logger.warn({
          event: 'payments.allocation_rebalance_failed',
          planId,
          error: errorName(error),
        });
      }
    }
    return drained;
  }

  /**
   * El plan del abono de la ruta (anulación). Si no se puede leer, se drena
   * igual, sin preferencia: el plan llega en este drenado o en el barrido.
   */
  private async planOfRoutePayment(
    paymentId: string | undefined,
  ): Promise<string | undefined> {
    if (!paymentId) return undefined;
    try {
      return (await this.repo.planOfPayment(paymentId)) ?? undefined;
    } catch (error) {
      this.logger.warn({
        event: 'payments.allocation_drain_preference_failed',
        error: errorName(error),
      });
      return undefined;
    }
  }

  /**
   * DX-375: congela la tasa de hasta `limit` abonos que la esperan («sin
   * tasa» o anteriores a DX-375), con la fuente de la clínica y el día civil
   * de cada uno, cotizada FUERA de transacción. Uno que sigue sin tasa queda
   * con su moneda de destino y lo reintenta la pasada siguiente; uno en su
   * misma moneda solo recibe su moneda de destino. Un convertidor por pasada.
   */
  async freezePendingRates(
    limit: number,
  ): Promise<{ frozen: number; withoutRate: number }> {
    const { frozen, withoutRate } = await this.freezeBatch(limit, []);
    return { frozen, withoutRate };
  }

  private async freezeBatch(
    limit: number,
    exclude: readonly string[],
  ): Promise<{ frozen: number; withoutRate: number; seen: string[] }> {
    const result = { frozen: 0, withoutRate: 0, seen: [] as string[] };
    const convert = this.convertAmount.memoized();
    for (const payment of await this.repo.paymentsPendingRate(limit, exclude)) {
      result.seen.push(payment.paymentId);
      let rate: FrozenExchangeRate | null;
      try {
        rate = await freezePaymentRate(convert, payment);
      } catch (error) {
        this.logger.warn({
          event: 'payments.exchange_rate_freeze_failed',
          paymentId: payment.paymentId,
          error: errorName(error),
        });
        result.withoutRate += 1;
        continue;
      }
      const frozen = await this.repo.freezeRate(
        payment.paymentId,
        payment.targetCurrency,
        rate,
      );
      if (frozen) result.frozen += 1;
      else if (payment.currency !== payment.targetCurrency) {
        result.withoutRate += 1;
      }
    }
    return result;
  }

  /**
   * DX-375 (BE-047): congela TODOS los abonos de la clínica que esperan su
   * tasa, por lotes de `batch`, antes de cambiar la fuente de la tasa: los
   * anteriores a DX-375 quedan con la tasa que tenían, y el cambio no los
   * mueve. Los que siguen sin tasa se cuentan y no se repiten.
   */
  async freezeAllPending(
    batch = 200,
  ): Promise<{ frozen: number; withoutRate: number }> {
    const total = { frozen: 0, withoutRate: 0 };
    const seen: string[] = [];
    for (;;) {
      const pass = await this.freezeBatch(batch, seen);
      if (pass.seen.length === 0) return total;
      seen.push(...pass.seen);
      total.frozen += pass.frozen;
      total.withoutRate += pass.withoutRate;
    }
  }

  /**
   * Bases que faltan (R9.3, R15): hasta `limit` abonos vivos sin base del
   * tenant actual, convertidos FUERA de transacción con la tasa de su día; la
   * base nace con su plan encolado. Sin tasa (o con el proveedor caído) se
   * cuentan como `withoutRate` y lo reintenta la pasada siguiente.
   */
  async createMissingBases(
    limit: number,
  ): Promise<{ created: number; withoutRate: number }> {
    const result = { created: 0, withoutRate: 0 };
    for (const payment of await this.repo.paymentsWithoutBase(limit)) {
      let amount: number | null;
      try {
        amount = await paymentBaseAmount(
          this.convertAmount,
          payment,
          payment.planCurrency,
        );
      } catch (error) {
        this.logger.warn({
          event: 'payments.allocation_base_conversion_failed',
          paymentId: payment.paymentId,
          error: errorName(error),
        });
        amount = null;
      }
      if (amount === null) {
        result.withoutRate += 1;
        continue;
      }
      const created = await this.repo.ensureBase(
        payment.paymentId,
        amount,
        payment.planCurrency,
        payment.paidOn,
      );
      if (created) result.created += 1;
    }
    return result;
  }
}
