import { BadRequestException, Injectable } from '@nestjs/common';
import {
  GetRatesForDateUseCase,
  isValidDateFormat,
} from './get-rates-for-date.use-case';

export interface ConvertAmountInput {
  amount: number;
  from: string;
  to: string;
  date: string;
}

export interface ConvertAmountResult {
  amount: number;
  from: string;
  to: string;
  date: string;
  result: number;
  /** Effective from→to rate actually applied (see rounding note below). */
  rateUsed: number;
}

function isFiniteNonNegativeAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Converts an amount between currencies using the historical rate of a
 * given date (so a payment always converts by the rate of ITS date, not
 * today's). Rates come from `GetRatesForDateUseCase` — this reuses that
 * use case (instead of talking to the repo/provider directly) so the
 * cache-then-fetch logic lives in exactly one place.
 */
@Injectable()
export class ConvertAmountUseCase {
  constructor(private readonly getRatesForDate: GetRatesForDateUseCase) {}

  async execute(input: ConvertAmountInput): Promise<ConvertAmountResult> {
    if (!isValidDateFormat(input.date)) {
      throw new BadRequestException('date must match YYYY-MM-DD');
    }
    if (!isFiniteNonNegativeAmount(input.amount)) {
      throw new BadRequestException('amount must be a finite number >= 0');
    }

    const { amount, from, to, date } = input;

    if (from === to) {
      return { amount, from, to, date, result: amount, rateUsed: 1 };
    }

    const { rates } = await this.getRatesForDate.execute(date);

    // Rates are "units of currency per 1 USD" (base USD); USD itself never
    // has (nor needs) a snapshot row.
    const rateFrom = from === 'USD' ? 1 : rates[from];
    if (rateFrom === undefined) {
      throw new BadRequestException(`unsupported currency: ${from}`);
    }
    const rateTo = to === 'USD' ? 1 : rates[to];
    if (rateTo === undefined) {
      throw new BadRequestException(`unsupported currency: ${to}`);
    }

    const usd = from === 'USD' ? amount : amount / rateFrom;
    const rawResult = to === 'USD' ? usd : usd * rateTo;

    // Rounding policy: the converted amount is a monetary value, so it is
    // rounded to 2 decimal places (round-half-away-from-zero on the cent
    // value via Math.round) — sub-cent precision isn't meaningful for a
    // stored/displayed payment amount. This rounding is applied ONLY to the
    // returned `result`, never to the intermediate USD figure, to avoid
    // compounding rounding error on the from→USD→to chain.
    const result = Math.round(rawResult * 100) / 100;

    // rateUsed is the effective from→to rate: derived from the (rounded)
    // result when amount != 0 (what the caller actually experienced), or
    // the unrounded from→to factor (rateTo / rateFrom) when amount is 0 and
    // result/amount would be an undefined division.
    const rateUsed = amount !== 0 ? result / amount : rateTo / rateFrom;

    return { amount, from, to, date, result, rateUsed };
  }
}
