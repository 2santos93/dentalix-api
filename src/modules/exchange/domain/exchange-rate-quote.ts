import { BASE_CURRENCY, type ExchangeRateSource } from './exchange-rate-source';
import { round2 } from '../../../shared/money/money';

/**
 * DX-375: la tasa con la que se convierte un importe de `from` a `to` un día,
 * tal como la dio la fuente de la clínica: las dos monedas en unidades por 1
 * USD (la base de todas las tasas; la base vale 1). Es lo que congela un abono
 * al registrarse, para que su conversión no cambie cuando cambie la tasa.
 */
export interface ExchangeRateQuote {
  from: string;
  to: string;
  /** Día civil (AAAA-MM-DD) para el que se pidió la tasa: el del abono. */
  date: string;
  /**
   * DX-384: día civil (AAAA-MM-DD) de la tasa usada. Igual a `date` salvo con
   * tasa manual cuando no había la de ese día: la última registrada dentro
   * del plazo de la clínica (nunca posterior a `date`). Es el que congela el
   * abono (`exchangeRateDate`).
   */
  rateDate: string;
  source: ExchangeRateSource;
  /** Unidades de `from` por 1 USD. */
  fromPerBase: number;
  /** Unidades de `to` por 1 USD. */
  toPerBase: number;
  /**
   * DX-402: la tasa es la manual de un día anterior a `manualSince` (la de
   * respaldo de un día sin tasa del proveedor). No se guarda en el abono:
   * sirve para auditar que se usó.
   */
  backup?: { manualSince: string };
  /**
   * DX-586: referencia estable a la tasa usada, la que guarda el abono
   * (`exchangeRateRef`): por cada moneda que no es USD, `BCV:<fecha valor>`
   * (VES y EUR con fuente BCV), `MANUAL:<id de la tasa manual>` o
   * `AUTOMATIC:<día de la tasa>`; si son dos distintas, unidas con «+».
   * Siempre la da `ConvertAmountUseCase`; opcional para los dobles de test.
   */
  ref?: string;
  /** DX-586: fecha valor del BCV (solo con fuente BCV y VES o EUR); si no, null. */
  valueDate?: string | null;
}

/** DX-586: separador de las referencias de las dos monedas de una cotización. */
export const RATE_REF_SEPARATOR = '+';

const MANUAL_REF_ID =
  /MANUAL:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** DX-586: los ids de tasas manuales que nombra una referencia (`MANUAL:<id>`). */
export function manualRateIdsOfRef(ref: string | null | undefined): string[] {
  if (!ref) return [];
  return [...ref.matchAll(MANUAL_REF_ID)].map((m) => m[1].toLowerCase());
}

/**
 * DX-586: la referencia de la tasa de una cotización (ver
 * `ExchangeRateQuote.ref`). `partOf` da la de cada moneda que no es USD.
 */
export function quoteRef(
  currencies: readonly string[],
  source: ExchangeRateSource,
  rateDate: string,
  partOf: (currency: string) => string,
): string {
  const parts = [
    ...new Set(
      currencies.filter((c) => c !== BASE_CURRENCY).map((c) => partOf(c)),
    ),
  ];
  return parts.length > 0
    ? parts.join(RATE_REF_SEPARATOR)
    : `${source}:${rateDate}`;
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
  return round2(raw);
}
