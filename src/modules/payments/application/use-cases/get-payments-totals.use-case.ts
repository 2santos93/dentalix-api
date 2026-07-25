import { Inject, Injectable } from '@nestjs/common';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type { PaymentRepository } from '../../domain/ports/payment-repository.port';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';

export interface GetPaymentsTotalsInput {
  from: Date;
  to: Date;
  currency: string;
}

export interface GetPaymentsTotalsResult {
  from: Date;
  to: Date;
  currency: string;
  /** Σ of each active payment's `amount`, converted to `currency` at ITS
   * OWN paidAt date (never today's rate), rounded to 2 decimals. */
  totalConverted: number;
  /** Number of active payments in the range (regardless of currency). */
  count: number;
  /** Breakdown of the ORIGINAL (unconverted) amounts grouped by each
   * payment's own currency, e.g. `{ COP: 500000, USD: 30 }`. */
  byCurrency: Record<string, number>;
}

// Same rounding policy as CreateSaleUseCase/ConvertAmountUseCase: monetary
// sums are rounded to 2 decimals to avoid floating point drift.
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// `paidAt` is stored as a full timestamp; `ConvertAmountUseCase` looks up an
// exchange snapshot keyed by calendar date (YYYY-MM-DD), always fetched/
// stored in UTC — so each payment must be converted using ITS OWN UTC date,
// not the server's local timezone (see GetSalesTotalsUseCase.toUtcDateString
// for the identical rationale this use case mirrors).
function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Mirrors `GetSalesTotalsUseCase` over `Payment` instead of `Sale` — this is
 * what `GetDoctorDashboardUseCase` now sources the "incomes of the period"
 * metric from (see docs/plans/2026-07-24-payments-pivot.md PAY-T2).
 */
@Injectable()
export class GetPaymentsTotalsUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly repo: PaymentRepository,
    private readonly convertAmount: ConvertAmountUseCase,
  ) {}

  async execute(
    input: GetPaymentsTotalsInput,
  ): Promise<GetPaymentsTotalsResult> {
    const currency = input.currency.trim().toUpperCase();

    const payments = await this.repo.listReceivedInRange({
      from: input.from,
      to: input.to,
    });

    let totalConverted = 0;
    const byCurrency: Record<string, number> = {};

    // IMP-4a: memoizes the conversion lookup per (calendar date, source
    // currency) within THIS execute() call. `currency` (the dashboard's
    // target) is invariant across the whole loop, so a payment's date+
    // currency pair fully determines its rate. Without this, N payments
    // sharing a date/currency (the common case: a clinic billing mostly in
    // one currency) would each re-trigger convertAmount.execute(), which
    // hits the DB for that date's rate every time. Only the FIRST payment
    // for a given pair does the real call; later payments reuse its
    // `rateUsed` against their OWN amount (round2 is idempotent, so this
    // reproduces the exact same value the first payment got, and is
    // consistent — to full rate precision — for the rest).
    const rateCache = new Map<string, Promise<{ rateUsed: number }>>();

    for (const payment of payments) {
      // Grouped in the payment's OWN currency, at its ORIGINAL (unconverted)
      // value — this is a breakdown of what was actually received, not a
      // converted figure. Computed unconditionally (not inside the
      // try/catch below): it never depends on the conversion succeeding.
      byCurrency[payment.currency] = round2(
        (byCurrency[payment.currency] ?? 0) + payment.amount,
      );

      // IMP-4b: a single payment with a stale/unconvertible currency must
      // not throw and fail the ENTIRE totals computation (and,
      // transitively, the whole dashboard/balance response) — skip it from
      // totalConverted instead. `count` (below, from payments.length) and
      // `byCurrency` (above) are unaffected, since neither depends on the
      // conversion succeeding.
      try {
        const date = toUtcDateString(payment.paidAt);
        const cacheKey = `${date}|${payment.currency}`;

        let cached = rateCache.get(cacheKey);
        if (!cached) {
          cached = this.convertAmount.execute({
            amount: payment.amount,
            from: payment.currency,
            to: currency,
            date,
          });
          rateCache.set(cacheKey, cached);
        }

        const { rateUsed } = await cached;
        totalConverted += round2(payment.amount * rateUsed);
      } catch {
        // Skip: leave this payment out of totalConverted. The failed (or
        // cached-as-failed) lookup is not retried for other payments
        // sharing the same date/currency — they hit the same rejection.
      }
    }

    return {
      from: input.from,
      to: input.to,
      currency,
      totalConverted: round2(totalConverted),
      count: payments.length,
      byCurrency,
    };
  }
}
