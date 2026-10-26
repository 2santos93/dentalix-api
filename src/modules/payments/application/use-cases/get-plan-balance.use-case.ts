import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TreatmentPlanItemStatus, TreatmentPlanStatus } from '@prisma/client';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type { PaymentRepository } from '../../domain/ports/payment-repository.port';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { isPlanBillable } from '../../../treatment-plans/domain/plan-status-machine';
import { PLAN_ALLOCATION_REPOSITORY } from '../../domain/ports/plan-allocation-repository.port';
import type { PlanAllocationRepository } from '../../domain/ports/plan-allocation-repository.port';
import { itemBillableCents } from '../../domain/allocation-rules';
import { paymentInPlanCurrency } from '../payment-in-plan-currency';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';

export interface GetPlanBalanceResult {
  planCurrency: string;
  /** 0 if the plan is not billable (REJECTED/CANCELLED, DX-109); otherwise
   * Σ (item.price − item.discount) for active items with status ACCEPTED|DONE (PROPOSED
   * items are not yet billable — see docs/plans/2026-07-24-payments-pivot.md
   * "Modelo"). Rounded to 2 decimals. */
  billable: number;
  /** Σ of every active payment for the plan, each converted to
   * `planCurrency` at ITS OWN `paidAt` date (never today's rate). Rounded
   * to 2 decimals. */
  paid: number;
  /** `billable - paid`, rounded to 2 decimals. */
  balance: number;
  /** Number of active payments for the plan. */
  paymentsCount: number;
}

/** Lo que la conversión necesita de un abono (el día civil ya resuelto). */
interface PlanPayment {
  id: string;
  amount: number;
  currency: string;
  paidOn: string;
}

/** Cobrado y pendiente de un ítem del plan (DX-051). */
export interface PlanItemBalance {
  itemId: string;
  toothNumber: string;
  procedureName: string;
  status: TreatmentPlanItemStatus;
  billable: number;
  paid: number;
  balance: number;
}

export interface GetPlanBalanceWithItemsResult extends GetPlanBalanceResult {
  /** Σ de las imputaciones de los abonos vivos del plan. */
  allocated: number;
  /** Σ de los sobrantes de los abonos con base: lo cobrado sin ítem. */
  unallocated: number;
  /** Abonos vivos sin base (sin tasa o de moneda no soportada). */
  unconvertedPaymentsCount: number;
  /** Abonos cuya imputación fijó un ADMIN a mano. */
  manualPaymentIds: string[];
  /** En el orden del plan. */
  items: PlanItemBalance[];
}

// Same rounding policy as CreateSaleUseCase/ConvertAmountUseCase: monetary
// sums are rounded to 2 decimals to avoid floating point drift.
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const BILLABLE_STATUSES: ReadonlySet<TreatmentPlanItemStatus> = new Set([
  TreatmentPlanItemStatus.ACCEPTED,
  TreatmentPlanItemStatus.DONE,
]);

/**
 * Computes the outstanding balance of a treatment plan: what's billable
 * (accepted + done items) minus what's actually been paid (active payments,
 * each converted to the plan's currency by its own paidAt date).
 */
@Injectable()
export class GetPlanBalanceUseCase {
  private readonly logger = new Logger(GetPlanBalanceUseCase.name);

  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly repo: PaymentRepository,
    private readonly getTreatmentPlan: GetTreatmentPlanUseCase,
    private readonly convertAmount: ConvertAmountUseCase,
    @Inject(PLAN_ALLOCATION_REPOSITORY)
    private readonly allocations: PlanAllocationRepository,
  ) {}

  /**
   * `execute` más el cobrado y pendiente por ítem (DX-051, R14). El plan, sus
   * ítems, los abonos y los hechos de imputación salen de UNA lectura
   * `RepeatableRead`; la conversión de moneda se hace fuera de ella, sobre
   * esos datos. Así lo imputado y lo facturable son de la misma foto.
   */
  async executeWithItems(
    treatmentPlanId: string,
  ): Promise<GetPlanBalanceWithItemsResult> {
    const snapshot =
      await this.allocations.readPlanBalanceSnapshot(treatmentPlanId);
    if (!snapshot) throw new NotFoundException('Treatment plan not found');
    const { plan, payments } = snapshot;
    const result = await this.compute(plan, snapshot.items, payments);
    const billablePlan = isPlanBillable(plan.status);

    const paidByItem = new Map<string, number>();
    const allocatedByPayment = new Map<string, number>();
    let allocatedCents = 0;
    for (const a of snapshot.allocations) {
      const cents = Math.round(a.amount * 100);
      paidByItem.set(a.itemId, (paidByItem.get(a.itemId) ?? 0) + cents);
      allocatedByPayment.set(
        a.paymentId,
        (allocatedByPayment.get(a.paymentId) ?? 0) + cents,
      );
      allocatedCents += cents;
    }

    const items: PlanItemBalance[] = snapshot.items.map((item) => {
      const billableCents = itemBillableCents(
        { ...item, deletedAt: null },
        billablePlan,
      );
      const paidCents = paidByItem.get(item.id) ?? 0;
      return {
        itemId: item.id,
        toothNumber: item.toothNumber,
        procedureName: item.procedureName,
        status: item.status,
        billable: billableCents / 100,
        paid: paidCents / 100,
        balance: (billableCents - paidCents) / 100,
      };
    });

    let unallocatedCents = 0;
    for (const base of snapshot.bases) {
      unallocatedCents +=
        Math.round(base.amount * 100) -
        (allocatedByPayment.get(base.paymentId) ?? 0);
    }
    const withBase = new Set(snapshot.bases.map((b) => b.paymentId));
    const unconvertedPaymentsCount = payments.filter(
      (p) => !withBase.has(p.id),
    ).length;

    // Con todos los abonos con base, lo imputado más lo sin imputar es lo
    // cobrado: si no, la base y la conversión en vivo discrepan (p. ej. una
    // tasa corregida después). No se rompe la lectura; se deja constancia.
    if (unconvertedPaymentsCount === 0) {
      const diff =
        allocatedCents + unallocatedCents - Math.round(result.paid * 100);
      if (diff !== 0) {
        this.logger.warn(
          `Plan ${treatmentPlanId}: allocated + unallocated differs from paid by ${diff} cents`,
        );
      }
    }

    return {
      ...result,
      allocated: allocatedCents / 100,
      unallocated: unallocatedCents / 100,
      unconvertedPaymentsCount,
      manualPaymentIds: snapshot.bases
        .filter((b) => b.manual)
        .map((b) => b.paymentId),
      items,
    };
  }

  async execute(treatmentPlanId: string): Promise<GetPlanBalanceResult> {
    // Throws NotFoundException when the plan is absent, soft-deleted, or
    // belongs to another tenant.
    const plan = await this.getTreatmentPlan.execute(treatmentPlanId);
    const payments = await this.repo.listByPlan(treatmentPlanId);
    return this.compute(plan, plan.items, payments);
  }

  private async compute(
    plan: { status: TreatmentPlanStatus; currency: string },
    planItems: {
      status: TreatmentPlanItemStatus;
      price: number;
      discount: number;
    }[],
    payments: PlanPayment[],
  ): Promise<GetPlanBalanceResult> {
    // DX-109 (BE-001): un plan no cobrable (rechazado o cancelado) no debe
    // nada, la misma regla que el estado de cuenta; sus abonos siguen en
    // `paid`.
    const billable = !isPlanBillable(plan.status)
      ? 0
      : round2(
          planItems
            .filter((item) => BILLABLE_STATUSES.has(item.status))
            .reduce((sum, item) => sum + item.price - item.discount, 0),
        );

    let paid = 0;

    for (const payment of payments) {
      // IMP-4b: a single payment with an unsupported/stale currency must
      // not throw and fail the ENTIRE balance computation — skip it from
      // `paid` instead. `paymentsCount` (below, from payments.length) is
      // unaffected, since it doesn't depend on the conversion succeeding.
      //
      // IMP-4a follow-up: this used to memoize `rateUsed` per (date,
      // source currency) and reapply it via `round2(amount * rateUsed)`
      // for every payment sharing that pair. That's unsound:
      // `ConvertAmountUseCase.rateUsed` is derived from ITS OWN
      // already-rounded result (`result / amount`), so it is
      // amount-dependent, not a fixed exchange rate — reusing it for a
      // different amount reproduces that first payment's rounding error
      // instead of rounding each payment independently, drifting the
      // total (e.g. amounts [1,2,5,7,100,333] at a 3-units-per-USD rate:
      // correct total is 149.33, memoized was 147.84). So every payment is
      // converted FRESH, by its own amount and own paidAt date, exactly as
      // before that optimization.
      // TODO(perf): memoize the RAW rate at the GetRatesForDateUseCase/
      // rate-repository layer (NOT the amount-dependent rateUsed) to
      // remove the per-payment lookup without drift.
      // DX-097: el día civil del abono en SU sede, la misma fecha de tasa
      // que usa el dashboard (GetPaymentsTotalsUseCase). Solo «moneda sin
      // tasa» se omite; cualquier otro fallo se propaga.
      const converted = await paymentInPlanCurrency(this.convertAmount, {
        amount: payment.amount,
        currency: payment.currency,
        planCurrency: plan.currency,
        paidOn: payment.paidOn,
      });
      if (converted === null) {
        this.logger.warn(
          `Skipping payment ${payment.id}: unsupported currency ${payment.currency}`,
        );
        continue;
      }
      paid += converted;
    }

    return {
      planCurrency: plan.currency,
      billable,
      paid: round2(paid),
      balance: round2(billable - paid),
      paymentsCount: payments.length,
    };
  }
}
