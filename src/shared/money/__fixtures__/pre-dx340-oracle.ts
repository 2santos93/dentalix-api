/**
 * Oráculo CONGELADO (DX-340): copia literal del redondeo de origin/main antes
 * de DX-340 (5a3048f8), para que las propiedades no comparen el código
 * nuevo consigo mismo. No se edita: si la regla cambia a propósito (una
 * decisión del dueño sobre `rounding_digits`), el test que lo usa tiene que
 * fallar y decirlo.
 *
 * Fuentes copiadas:
 *   - src/shared/money/currency-decimals.ts (ZERO_DECIMAL_CURRENCIES, 29)
 *   - src/modules/discounts/domain/discount-policy.ts (discountForPercent)
 *   - src/modules/treatment-plans/domain/pricing/resolve-item-price.ts
 *     (percentPrice)
 *   - src/modules/payments/application/use-cases/get-plan-balance.use-case.ts
 *     (billable: suma en coma flotante + round2)
 *   - src/modules/treatment-plans/application/use-cases/get-treatment-plan.use-case.ts
 *     (total en céntimos)
 */

/** ZERO_DECIMAL_CURRENCIES de main, en literal (CLDR 47 ∪ COP, CLP, JPY, KRW, PYG). */
export const PRE_DX340_ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'AFN',
  'ALL',
  'BIF',
  'CLP',
  'COP',
  'DJF',
  'GNF',
  'IRR',
  'ISK',
  'JPY',
  'KMF',
  'KPW',
  'KRW',
  'LAK',
  'LBP',
  'MGA',
  'MMK',
  'PYG',
  'RSD',
  'RWF',
  'SOS',
  'SYP',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
  'YER',
]);

function currencyDecimals(currency: string): 0 | 2 {
  return PRE_DX340_ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

function cents(amount: number): bigint {
  return BigInt(Math.round(amount * 100));
}

function basisPoints(percent: number): bigint {
  return BigInt(Math.round(percent * 100));
}

export function oldDiscountForPercent(
  price: number,
  percent: number,
  currency: string,
  capPercent: number,
): number {
  const unit = 10n ** BigInt(2 - currencyDecimals(currency));
  const priceCents = cents(price);
  const scale = unit * 10000n;
  const rounded = (priceCents * basisPoints(percent) + scale / 2n) / scale;
  const capped = (priceCents * basisPoints(capPercent)) / scale;
  const whole = priceCents / unit;
  let units = rounded;
  if (capped < units) units = capped;
  if (whole < units) units = whole;
  return Number(units * unit) / 100;
}

export function oldPercentPrice(
  base: number,
  percent: number,
  currency: string,
): number {
  const p = Math.min(100, Math.max(0, percent));
  const baseCents = BigInt(Math.round(base * 100));
  const unit = 10n ** BigInt(2 - currencyDecimals(currency));
  const scale = unit * 10000n;
  const numerator = baseCents * (10000n - BigInt(Math.round(p * 100)));
  let units = (numerator + scale / 2n) / scale;
  const whole = baseCents / unit;
  if (units > whole) units = whole;
  return Number(units * unit) / 100;
}

interface OldItem {
  status: 'PROPOSED' | 'ACCEPTED' | 'DONE';
  price: number;
  discount: number;
}

/** `billable` de GetPlanBalanceUseCase en main (plan cobrable). */
export function oldBillable(items: readonly OldItem[]): number {
  const sum = items
    .filter((item) => item.status === 'ACCEPTED' || item.status === 'DONE')
    .reduce((acc, item) => acc + item.price - item.discount, 0);
  return Math.round(sum * 100) / 100;
}

/** `total` de GetTreatmentPlanUseCase en main (todos los ítems vivos). */
export function oldPlanTotal(items: readonly OldItem[]): number {
  const total = items.reduce(
    (sum, item) =>
      sum + Math.round(item.price * 100) - Math.round(item.discount * 100),
    0,
  );
  return total / 100;
}
