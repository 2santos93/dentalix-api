import { Inject, Injectable, Logger } from '@nestjs/common';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type { PaymentRepository } from '../../domain/ports/payment-repository.port';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';
import { paymentAmountIn } from '../payment-exchange-rate';

/**
 * Período en días CIVILES (YYYY-MM-DD, ambos inclusive, ya validados por quien
 * llama): cada sede lo corta en su zona (DX-097).
 */
export interface GetPaymentsTotalsInput {
  from: string;
  to: string;
  currency: string;
}

export interface GetPaymentsTotalsResult {
  from: string;
  to: string;
  currency: string;
  /** Σ of each active payment's `amount` converted to `currency` with the
   * rate it froze when it was recorded (DX-375) or, for an older payment not
   * frozen yet, at ITS OWN civil paid date in its location's zone (never
   * today's rate), rounded to 2 decimals. */
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
    // DX-374: un convertidor por cálculo, que lee la fuente de la clínica y
    // las tasas de cada día una sola vez (no una lectura por abono).
    const convert = this.convertAmount.memoized();

    for (const payment of payments) {
      // Grouped in the payment's OWN currency, at its ORIGINAL (unconverted)
      // value — this is a breakdown of what was actually received, not a
      // converted figure. Computed unconditionally (not inside the
      // try/catch below): it never depends on the conversion succeeding.
      byCurrency[payment.currency] = round2(
        (byCurrency[payment.currency] ?? 0) + payment.amount,
      );

      // IMP-4a/4b: cada abono se convierte por su propio importe y uno sin
      // tasa no tumba el total (no suma en `totalConverted`; `count` y
      // `byCurrency` no cambian). DX-375: con su tasa congelada, siempre con
      // ella; un abono anterior aún sin congelar, con la tasa de su día civil
      // en SU sede (DX-097), como antes. Cualquier otro fallo se propaga.
      const converted = await paymentAmountIn(convert, payment, currency);
      if (converted === null) {
        this.logger.warn(
          `Skipping payment ${payment.id}: no rate for ${payment.currency}`,
        );
        continue;
      }
      totalConverted += converted;
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
