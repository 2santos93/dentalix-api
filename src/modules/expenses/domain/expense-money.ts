import type { CurrencyTexts } from '../../../shared/format/currency-text';
import { moneyWithCode } from '../../../shared/format/money-with-code';
import {
  requireLocationFormat,
  type LocationFormatSource,
} from '../../../shared/locations/location-regional';

/** Un importe en céntimos, escrito para un mensaje. */
export type ExpenseMoneyText = (cents: number) => string;

/**
 * DX-354: los importes de los mensajes de un gasto, con los separadores de la
 * SEDE del gasto y el código ISO de su moneda («1.234,50 EUR», «USD 1,234.50»)
 * o, si la clínica le dio uno (`texts`, DX-517-quater), el texto propio de la
 * moneda («Bs. 1.234,50»).
 * PEREZOSO: el formato de la sede se exige al escribir el primer importe, así
 * que una sede sin formato solo da 409 `LOCATION_LOCALE_REQUIRED` si hay un
 * mensaje con cifras que escribir.
 */
export function expenseMoneyText(
  location: LocationFormatSource,
  currency: string,
  texts: CurrencyTexts | null = null,
): ExpenseMoneyText {
  return (cents) =>
    moneyWithCode(
      cents / 100,
      currency,
      requireLocationFormat(location),
      texts,
    );
}
