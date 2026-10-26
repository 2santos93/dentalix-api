import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConvertAmountUseCase } from '../../exchange/application/use-cases/convert-amount.use-case';
import { respreadSurplus } from '../domain/allocation-rules';
import {
  PLAN_ALLOCATION_REPOSITORY,
  type PlanAllocationRepository,
} from '../domain/ports/plan-allocation-repository.port';
import { errorName, paymentBaseAmount } from './payment-in-plan-currency';

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
        amount = await paymentBaseAmount(this.convertAmount, payment);
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
