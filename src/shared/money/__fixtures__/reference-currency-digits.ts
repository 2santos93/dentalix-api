import { CURRENCY_DIGITS } from '../../../../prisma/reference/currency-digits';
import { CurrencyDigitsCatalog, CurrencyDigitsTable } from '../currency-digits';

/** La tabla de la referencia versionada (la que rellena la migración). */
export const REFERENCE_CURRENCY_DIGITS = new CurrencyDigitsTable(
  CURRENCY_DIGITS,
);

/** Catálogo en memoria para los unit: los mismos valores que la BD migrada. */
export function referenceCurrencyDigitsCatalog(): CurrencyDigitsCatalog {
  return { table: () => Promise.resolve(REFERENCE_CURRENCY_DIGITS) };
}
