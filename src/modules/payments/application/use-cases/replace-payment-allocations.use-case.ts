import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';
import { isPlanBillable } from '../../../treatment-plans/domain/plan-status-machine';
import {
  ALLOCATION_MIGRATED_BALANCE,
  ALLOCATION_PAYMENT_NOT_FOUND,
  allocationNoRate,
  allocationPlanNotBillable,
} from '../../domain/allocation-messages';
import {
  PLAN_ALLOCATION_REPOSITORY,
  type AllocationTarget,
  type PlanAllocationRepository,
} from '../../domain/ports/plan-allocation-repository.port';
import { paymentInPlanCurrency } from '../payment-in-plan-currency';
import { PlanAllocationRebalancer } from '../plan-allocation-rebalancer';
import {
  GetPaymentAllocationsUseCase,
  type PaymentAllocationsView,
} from './get-payment-allocations.use-case';

export interface ReplacePaymentAllocationsCommand {
  expectedVersion: string;
  mode: 'MANUAL' | 'AUTO';
  /** Obligatorio con MANUAL, ausente con AUTO (lo exige el DTO). */
  allocations?: { treatmentPlanItemId: string; amount: number }[];
}

export interface ReplacedPaymentAllocations extends PaymentAllocationsView {
  previous: { treatmentPlanItemId: string; amount: number }[];
}

/**
 * PUT /payments/:id/allocations (DX-051, spec R10): un ADMIN fija la
 * imputación del abono a mano (MANUAL) o la devuelve al reparto automático
 * (AUTO). Sin base, la conversión va ANTES de la transacción y la base nace
 * con `ensureBase` (abono FOR SHARE, como el barrido). Tras el COMMIT reparte
 * el plan (lo que el abono deja libre lo llenan otros abonos) y la respuesta
 * se lee después del reparto.
 */
@Injectable()
export class ReplacePaymentAllocationsUseCase {
  private readonly logger = new Logger('PaymentAllocations');

  constructor(
    @Inject(PLAN_ALLOCATION_REPOSITORY)
    private readonly repo: PlanAllocationRepository,
    private readonly rebalancer: PlanAllocationRebalancer,
    private readonly convertAmount: ConvertAmountUseCase,
    private readonly getAllocations: GetPaymentAllocationsUseCase,
  ) {}

  async execute(
    paymentId: string,
    command: ReplacePaymentAllocationsCommand,
    actorId: string,
  ): Promise<ReplacedPaymentAllocations> {
    const found = await this.repo.findAllocationTarget(paymentId);
    const target = await this.withBase(checkTarget(found));
    const planId = target.treatmentPlanId as string;

    const { previous } = await this.repo.replaceAllocations({
      paymentId,
      mode: command.mode,
      expectedVersion: command.expectedVersion,
      lines:
        command.mode === 'MANUAL'
          ? (command.allocations ?? []).map((l) => ({
              itemId: l.treatmentPlanItemId,
              cents: Math.round(l.amount * 100),
            }))
          : [],
      actorId,
    });

    try {
      await this.rebalancer.rebalancePlan(planId, actorId);
    } catch (error) {
      // El plan sigue en la cola: lo reparte el interceptor o el barrido.
      this.logger.warn({
        event: 'payments.allocation_rebalance_failed',
        planId,
        error: error instanceof Error ? error.name : typeof error,
      });
    }

    const view = await this.getAllocations.execute(paymentId);
    return {
      ...view,
      previous: previous.map((p) => ({
        treatmentPlanItemId: p.itemId,
        amount: p.cents / 100,
      })),
    };
  }

  /**
   * La base del abono; si falta (abono anterior a DX-051 o cobrado sin tasa),
   * la convierte con la tasa de su día y la crea. Sin tasa, 409 (R15).
   */
  private async withBase(target: AllocationTarget): Promise<AllocationTarget> {
    if (target.base) return target;
    const planCurrency = target.planCurrency as string;
    const amount = await paymentInPlanCurrency(this.convertAmount, {
      amount: target.amount,
      currency: target.currency,
      planCurrency,
      paidOn: target.paidOn,
    });
    if (amount === null || amount <= 0) throw noRate(target);
    await this.repo.ensureBase(
      target.paymentId,
      amount,
      planCurrency,
      target.paidOn,
    );
    const reread = checkTarget(
      await this.repo.findAllocationTarget(target.paymentId),
    );
    if (!reread.base) throw noRate(reread);
    return reread;
  }
}

/** 404, saldo migrado o plan no cobrable (§5.3), en ese orden. */
function checkTarget(target: AllocationTarget | null): AllocationTarget {
  if (!target) throw new NotFoundException(ALLOCATION_PAYMENT_NOT_FOUND);
  if (!target.treatmentPlanId || !target.planStatus || !target.planCurrency) {
    throw new ConflictException(ALLOCATION_MIGRATED_BALANCE);
  }
  if (!isPlanBillable(target.planStatus)) {
    throw new ConflictException(allocationPlanNotBillable(target.planStatus));
  }
  return target;
}

function noRate(target: AllocationTarget): ConflictException {
  return new ConflictException(
    allocationNoRate(
      target.currency,
      target.planCurrency as string,
      target.paidOn,
    ),
  );
}
