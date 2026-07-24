import { Inject, Injectable } from '@nestjs/common';
import { SALE_REPOSITORY } from '../../domain/ports/sale-repository.port';
import type { SaleRepository } from '../../domain/ports/sale-repository.port';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';

export interface GetSalesTotalsInput {
  from: Date;
  to: Date;
  currency: string;
}

export interface GetSalesTotalsResult {
  from: Date;
  to: Date;
  currency: string;
  /** Σ of each sale's `total`, converted to `currency` at ITS OWN paidAt
   * date (never today's rate), rounded to 2 decimals. */
  totalConverted: number;
  /** Number of active sales in the range (regardless of currency). */
  count: number;
  /** Breakdown of the ORIGINAL (unconverted) totals grouped by the sale's
   * own currency, e.g. `{ COP: 500000, USD: 30 }`. */
  byCurrency: Record<string, number>;
}

// Same rounding policy as CreateSaleUseCase/ConvertAmountUseCase: monetary
// sums are rounded to 2 decimals to avoid floating point drift.
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// `paidAt` is stored as a full timestamp; `ConvertAmountUseCase` looks up an
// exchange snapshot keyed by calendar date (YYYY-MM-DD), and that snapshot
// is always fetched/stored in UTC (see GetRatesForDateUseCase /
// OpenExchangeRatesProvider) — so each sale must be converted using ITS OWN
// UTC date, not the server's local timezone, otherwise a sale near midnight
// could be converted at the wrong day's rate. `toISOString()` always
// renders in UTC regardless of the process's local timezone, so slicing the
// first 10 chars ("YYYY-MM-DD") is safe here.
function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

@Injectable()
export class GetSalesTotalsUseCase {
  constructor(
    @Inject(SALE_REPOSITORY)
    private readonly repo: SaleRepository,
    private readonly convertAmount: ConvertAmountUseCase,
  ) {}

  async execute(input: GetSalesTotalsInput): Promise<GetSalesTotalsResult> {
    const currency = input.currency.trim().toUpperCase();

    const sales = await this.repo.listForTotals({
      from: input.from,
      to: input.to,
    });

    let totalConverted = 0;
    const byCurrency: Record<string, number> = {};

    for (const sale of sales) {
      // Grouped in the sale's OWN currency, at its ORIGINAL (unconverted)
      // value — this is a breakdown of what was actually charged, not a
      // converted figure.
      byCurrency[sale.currency] = round2(
        (byCurrency[sale.currency] ?? 0) + sale.total,
      );

      const { result } = await this.convertAmount.execute({
        amount: sale.total,
        from: sale.currency,
        to: currency,
        date: toUtcDateString(sale.paidAt),
      });
      totalConverted += result;
    }

    return {
      from: input.from,
      to: input.to,
      currency,
      totalConverted: round2(totalConverted),
      count: sales.length,
      byCurrency,
    };
  }
}
