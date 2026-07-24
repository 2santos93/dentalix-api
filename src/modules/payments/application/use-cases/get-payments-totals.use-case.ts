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

    for (const payment of payments) {
      // Grouped in the payment's OWN currency, at its ORIGINAL (unconverted)
      // value — this is a breakdown of what was actually received, not a
      // converted figure.
      byCurrency[payment.currency] = round2(
        (byCurrency[payment.currency] ?? 0) + payment.amount,
      );

      const { result } = await this.convertAmount.execute({
        amount: payment.amount,
        from: payment.currency,
        to: currency,
        date: toUtcDateString(payment.paidAt),
      });
      totalConverted += result;
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
