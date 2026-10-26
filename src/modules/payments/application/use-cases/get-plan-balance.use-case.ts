import { Inject, Injectable, Logger } from '@nestjs/common';
import { TreatmentPlanItemStatus } from '@prisma/client';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type { PaymentRepository } from '../../domain/ports/payment-repository.port';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { isPlanBillable } from '../../../treatment-plans/domain/plan-status-machine';
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
  ) {}

  async execute(treatmentPlanId: string): Promise<GetPlanBalanceResult> {
    // Throws NotFoundException when the plan is absent, soft-deleted, or
    // belongs to another tenant.
    const plan = await this.getTreatmentPlan.execute(treatmentPlanId);

    // DX-109 (BE-001): un plan no cobrable (rechazado o cancelado) no debe
    // nada, la misma regla que el estado de cuenta; sus abonos siguen en
    // `paid`.
    const billable = !isPlanBillable(plan.status)
      ? 0
      : round2(
          plan.items
            .filter((item) => BILLABLE_STATUSES.has(item.status))
            .reduce((sum, item) => sum + item.price - item.discount, 0),
        );

    const payments = await this.repo.listByPlan(treatmentPlanId);

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
