import { BadRequestException, Injectable } from '@nestjs/common';
import {
  GetRatesForDateUseCase,
  invalidRateDate,
  isValidRateDate,
  type RatesLookup,
  type RatesLookupOptions,
} from './get-rates-for-date.use-case';
import { MissingExchangeRateError } from '../../domain/missing-exchange-rate.error';
import { BASE_CURRENCY } from '../../domain/exchange-rate-source';
import {
  convertWithQuote,
  type ExchangeRateQuote,
} from '../../domain/exchange-rate-quote';

export { convertWithQuote, type ExchangeRateQuote };

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

export interface QuoteInput {
  from: string;
  to: string;
  date: string;
}

/** Lo que necesita quien convierte: `ConvertAmountUseCase` o su versión memoizada. */
export interface AmountConverter {
  execute(input: ConvertAmountInput): Promise<ConvertAmountResult>;
  /**
   * DX-375: la tasa de `from` a `to` ese día con su fuente, sin convertir
   * nada (lo que congela un abono). Lanza lo mismo que `execute` cuando una
   * moneda no tiene tasa.
   */
  quote(input: QuoteInput): Promise<ExchangeRateQuote>;
}

function isFiniteNonNegativeAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Converts an amount between currencies using the historical rate of a
 * given date (so a payment always converts by the rate of ITS date, not
 * today's). Rates come from `GetRatesForDateUseCase` — this reuses that
 * use case (instead of talking to the repo/provider directly) so the
 * cache-then-fetch logic lives in exactly one place. DX-374: también la
 * fuente de la clínica del contexto (proveedor o tasa manual).
 */
@Injectable()
export class ConvertAmountUseCase implements AmountConverter {
  constructor(private readonly getRatesForDate: GetRatesForDateUseCase) {}

  execute(input: ConvertAmountInput): Promise<ConvertAmountResult> {
    return this.convertWith(input, (date) =>
      this.getRatesForDate.execute(date),
    );
  }

  quote(input: QuoteInput): Promise<ExchangeRateQuote> {
    return this.quoteWith(input, (date) => this.getRatesForDate.execute(date));
  }

  /**
   * SEC-054: la conversión de `GET /exchange/convert`, que solo pide al
   * proveedor los días de la ventana de la clínica (`forRequest`).
   */
  forRequest(input: ConvertAmountInput): Promise<ConvertAmountResult> {
    return this.convertWith(input, (date) =>
      this.getRatesForDate.forRequest(date),
    );
  }

  /**
   * Un convertidor para UN caso de uso de UNA clínica (saldo, totales): lee
   * los ajustes y las tasas de cada día una sola vez. Cada abono se sigue
   * convirtiendo por su importe (sin reutilizar `rateUsed`, ver IMP-4a).
   */
  memoized(options: RatesLookupOptions = {}): AmountConverter {
    const lookup = this.getRatesForDate.memoized(options);
    return {
      execute: (input) => this.convertWith(input, lookup),
      quote: (input) => this.quoteWith(input, lookup),
    };
  }

  private async quoteWith(
    input: QuoteInput,
    ratesFor: RatesLookup,
  ): Promise<ExchangeRateQuote> {
    if (!isValidRateDate(input.date)) throw invalidRateDate();
    const { from, to, date } = input;
    let read = await ratesFor(date);
    // DX-402: la tasa de respaldo solo vale si cubre las dos monedas; si no,
    // la cotización entera sale del camino automático (una sola fuente).
    const covered = (currency: string) =>
      currency === BASE_CURRENCY || read.rates[currency] !== undefined;
    if (read.backup && !(covered(from) && covered(to))) {
      read = await ratesFor(date, { noBackup: true });
    }
    const { rates, source, backup } = read;
    // DX-374: con tasa manual, una moneda ausente es la tasa que la clínica
    // aún no registró ese día (error de dominio en español); con el
    // proveedor, una moneda que no trae.
    const perBase = (currency: string): number => {
      // Rates are "units of currency per 1 USD" (base USD); USD itself never
      // has (nor needs) a snapshot row.
      if (currency === BASE_CURRENCY) return 1;
      const rate = rates[currency];
      if (rate !== undefined) return rate;
      throw source === 'MANUAL'
        ? new MissingExchangeRateError(currency, date)
        : new BadRequestException(`unsupported currency: ${currency}`);
    };
    const fromPerBase = perBase(from);
    const toPerBase = perBase(to);
    return {
      from,
      to,
      date,
      source,
      fromPerBase,
      toPerBase,
      ...(backup ? { backup } : {}),
    };
  }

  private async convertWith(
    input: ConvertAmountInput,
    ratesFor: RatesLookup,
  ): Promise<ConvertAmountResult> {
    if (!isValidRateDate(input.date)) throw invalidRateDate();
    if (!isFiniteNonNegativeAmount(input.amount)) {
      throw new BadRequestException('amount must be a finite number >= 0');
    }

    const { amount, from, to, date } = input;

    if (from === to) {
      return { amount, from, to, date, result: amount, rateUsed: 1 };
    }

    const quote = await this.quoteWith({ from, to, date }, ratesFor);

    // Rounding policy: the converted amount is a monetary value, so it is
    // rounded to 2 decimal places (round-half-away-from-zero on the cent
    // value via Math.round) — sub-cent precision isn't meaningful for a
    // stored/displayed payment amount. This rounding is applied ONLY to the
    // returned `result`, never to the intermediate USD figure, to avoid
    // compounding rounding error on the from→USD→to chain.
    const result = convertWithQuote(amount, quote);

    // rateUsed is the effective from→to rate: derived from the (rounded)
    // result when amount != 0 (what the caller actually experienced), or
    // the unrounded from→to factor (rateTo / rateFrom) when amount is 0 and
    // result/amount would be an undefined division.
    const rateUsed =
      amount !== 0 ? result / amount : quote.toPerBase / quote.fromPerBase;

    return { amount, from, to, date, result, rateUsed };
  }
}
