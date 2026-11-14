import type { ExchangeRateSource } from '@prisma/client';
import type { AmountConverter } from '../../exchange/application/use-cases/convert-amount.use-case';
import { MissingExchangeRateError } from '../../exchange/domain/missing-exchange-rate.error';
import { BASE_CURRENCY } from '../../exchange/domain/exchange-rate-source';
import { isNoRateError } from '../../payments/application/payment-in-plan-currency';
import { toRateColumn } from '../../../shared/money/rate-conversion';
import type { RoundingDigits } from '../../../shared/money/line-rounding';
import type { ReferenceRateLookup } from '../domain/ports/reference-rate-source.port';

/**
 * DX-513-bis §4.11: el día de la tasa. Con tasa manual, el día civil de la
 * sede de escritura (la última registrada dentro del plazo, DX-384, la elige
 * la lectura). Con la del proveedor, `min(día de la sede, día UTC)`: una sede
 * al este de UTC, antes de la medianoche UTC, pediría un día que para el
 * proveedor aún no ha llegado (a Venezuela, UTC−4, no le afecta).
 */
export function referenceRateDay(
  source: ExchangeRateSource,
  sedeToday: string,
  utcToday: string,
): string {
  if (source === 'AUTOMATIC' && utcToday < sedeToday) return utcToday;
  return sedeToday;
}

/**
 * La tasa de `from` a `to` de ese día con la fuente de la clínica, tal como la
 * congelan las columnas (8 decimales, como un abono, DX-375), o «sin tasa»
 * (`isNoRateError`: la manual que falta, el proveedor que no la da o no
 * contesta, el presupuesto agotado). Cualquier otro fallo se propaga.
 */
export async function lookupReferenceRate(
  convert: Pick<AmountConverter, 'quote'>,
  input: { from: string; to: string; date: string },
  toDigits: RoundingDigits,
  /** El día con el formato de la sede (para el mensaje de «sin tasa»). */
  dayLabel: (day: string) => string | null = () => null,
): Promise<ReferenceRateLookup> {
  try {
    const quote = await convert.quote(input);
    const fromPerBase = toRateColumn(quote.fromPerBase);
    const toPerBase = toRateColumn(quote.toPerBase);
    if (fromPerBase <= 0 || toPerBase <= 0) {
      return {
        kind: 'missing',
        currency: input.from,
        date: input.date,
        dateLabel: dayLabel(input.date),
      };
    }
    return {
      kind: 'rate',
      rate: {
        fromPerBase,
        toPerBase,
        source: quote.source,
        rateDate: quote.rateDate,
      },
      toDigits,
    };
  } catch (error) {
    if (!isNoRateError(error)) throw error;
    return {
      kind: 'missing',
      currency:
        error instanceof MissingExchangeRateError
          ? error.currency
          : input.from === BASE_CURRENCY
            ? input.to
            : input.from,
      date: input.date,
      dateLabel: dayLabel(input.date),
    };
  }
}
