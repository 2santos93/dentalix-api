import { Inject, Injectable } from '@nestjs/common';
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

/**
 * Computes the outstanding balance of a treatment plan: what's billable
 * (accepted + done items) minus what's actually been paid (active payments,
 * each converted to the plan's currency by its own paidAt date).
 */
@Injectable()
export class GetPlanBalanceUseCase {
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

    // IMP-4a: memoizes the conversion lookup per (calendar date, source
    // currency) within THIS execute() call. `plan.currency` (the target)
    // is invariant across the whole loop, so a payment's date+currency
    // pair fully determines its rate. Without this, N payments sharing a
    // date/currency would each re-trigger convertAmount.execute(), which
    // hits the DB for that date's rate every time. Only the FIRST payment
    // for a given pair does the real call; later payments reuse its
    // `rateUsed` against their OWN amount (round2 is idempotent, so this
    // reproduces the exact same value the first payment got, and is
    // consistent — to full rate precision — for the rest).
    const rateCache = new Map<string, Promise<{ rateUsed: number }>>();

    for (const payment of payments) {
      // IMP-4b: a single payment with a stale/unconvertible currency must
      // not throw and fail the ENTIRE balance computation — skip it from
      // `paid` instead. `paymentsCount` (below, from payments.length) is
      // unaffected, since it doesn't depend on the conversion succeeding.
      try {
        const date = toUtcDateString(payment.paidAt);
        const cacheKey = `${date}|${payment.currency}`;

        let cached = rateCache.get(cacheKey);
        if (!cached) {
          cached = this.convertAmount.execute({
            amount: payment.amount,
            from: payment.currency,
            to: plan.currency,
            date,
          });
          rateCache.set(cacheKey, cached);
        }

        const { rateUsed } = await cached;
        paid += round2(payment.amount * rateUsed);
      } catch {
        // Skip: leave this payment out of `paid`. The failed (or
        // cached-as-failed) lookup is not retried for other payments
        // sharing the same date/currency — they hit the same rejection.
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
