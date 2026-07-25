import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { TreatmentPlanItemStatus } from '@prisma/client';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type { PaymentRepository } from '../../domain/ports/payment-repository.port';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';

export interface GetPlanBalanceResult {
  planCurrency: string;
  /** Σ item.price for active items with status ACCEPTED|DONE (PROPOSED
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

// `paidAt` is stored as a full timestamp; `ConvertAmountUseCase` looks up an
// exchange snapshot keyed by calendar date (YYYY-MM-DD), and that snapshot
// is always fetched/stored in UTC — so each payment must be converted using
// ITS OWN UTC date, not the server's local timezone (same rationale as
// GetSalesTotalsUseCase.toUtcDateString).
function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// `ConvertAmountUseCase` throws exactly this kind of error (see
// convert-amount.use-case.ts) when a payment's stored currency has no rate
// in that date's snapshot. This is the ONLY failure this use case treats as
// "safe to skip" — anything else (a DB/infra outage inside
// GetRatesForDateUseCase, a programming error, etc.) must propagate instead
// of silently corrupting a plan balance with no trace.
function isUnsupportedCurrencyError(error: unknown): boolean {
  return (
    error instanceof BadRequestException &&
    typeof error.message === 'string' &&
    error.message.startsWith('unsupported currency')
  );
}

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

    const billable = round2(
      plan.items
        .filter((item) => BILLABLE_STATUSES.has(item.status))
        .reduce((sum, item) => sum + item.price, 0),
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
      try {
        const date = toUtcDateString(payment.paidAt);
        const { rateUsed } = await this.convertAmount.execute({
          amount: payment.amount,
          from: payment.currency,
          to: plan.currency,
          date,
        });
        paid += round2(payment.amount * rateUsed);
      } catch (error) {
        if (!isUnsupportedCurrencyError(error)) {
          throw error;
        }
        this.logger.warn(
          `Skipping payment ${payment.id}: unsupported currency ${payment.currency}`,
        );
      }
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
