import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
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

// `ConvertAmountUseCase` throws exactly this kind of error (see
// convert-amount.use-case.ts) when a payment's stored currency has no rate
// in that date's snapshot. This is the ONLY failure this use case treats as
// "safe to skip" — anything else (a DB/infra outage inside
// GetRatesForDateUseCase, a programming error, etc.) must propagate instead
// of silently corrupting a financial total with no trace.
function isUnsupportedCurrencyError(error: unknown): boolean {
  return (
    error instanceof BadRequestException &&
    typeof error.message === 'string' &&
    error.message.startsWith('unsupported currency')
  );
}

/**
 * Mirrors `GetSalesTotalsUseCase` over `Payment` instead of `Sale` — this is
 * what `GetDoctorDashboardUseCase` now sources the "incomes of the period"
 * metric from (see docs/plans/2026-07-24-payments-pivot.md PAY-T2).
 */
@Injectable()
export class GetPaymentsTotalsUseCase {
  private readonly logger = new Logger(GetPaymentsTotalsUseCase.name);

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

    for (const payment of payments) {
      // Grouped in the payment's OWN currency, at its ORIGINAL (unconverted)
      // value — this is a breakdown of what was actually received, not a
      // converted figure. Computed unconditionally (not inside the
      // try/catch below): it never depends on the conversion succeeding.
      byCurrency[payment.currency] = round2(
        (byCurrency[payment.currency] ?? 0) + payment.amount,
      );

      // IMP-4b: a single payment with an unsupported/stale currency must
      // not throw and fail the ENTIRE totals computation (and,
      // transitively, the whole dashboard/balance response) — skip it from
      // totalConverted instead. `count` (below, from payments.length) and
      // `byCurrency` (above) are unaffected, since neither depends on the
      // conversion succeeding.
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
          to: currency,
          date,
        });
        totalConverted += round2(payment.amount * rateUsed);
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
      from: input.from,
      to: input.to,
      currency,
      totalConverted: round2(totalConverted),
      count: payments.length,
      byCurrency,
    };
  }
}
