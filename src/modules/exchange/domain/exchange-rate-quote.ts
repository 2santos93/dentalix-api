import { BASE_CURRENCY, type ExchangeRateSource } from './exchange-rate-source';

/**
 * DX-375: la tasa con la que se convierte un importe de `from` a `to` un día,
 * tal como la dio la fuente de la clínica: las dos monedas en unidades por 1
 * USD (la base de todas las tasas; la base vale 1). Es lo que congela un abono
 * al registrarse, para que su conversión no cambie cuando cambie la tasa.
 */
export interface ExchangeRateQuote {
  from: string;
  to: string;
  /** Día civil (AAAA-MM-DD) de la tasa. */
  date: string;
  source: ExchangeRateSource;
  /** Unidades de `from` por 1 USD. */
  fromPerBase: number;
  /** Unidades de `to` por 1 USD. */
  toPerBase: number;
}

/**
 * El importe convertido con una cotización: `from` → USD → `to`, redondeado a
 * céntimos solo al final (la misma política que `ConvertAmountUseCase`, que
 * la usa: el resultado es idéntico al de convertir en vivo con esas tasas).
 */
export function convertWithQuote(
  amount: number,
  quote: Pick<ExchangeRateQuote, 'from' | 'to' | 'fromPerBase' | 'toPerBase'>,
): number {
  const usd =
    quote.from === BASE_CURRENCY ? amount : amount / quote.fromPerBase;
  const raw = quote.to === BASE_CURRENCY ? usd : usd * quote.toPerBase;
  return Math.round(raw * 100) / 100;
}
