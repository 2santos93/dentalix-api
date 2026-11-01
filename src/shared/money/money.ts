/**
 * Dinero en la API (DX-054): los importes son `Decimal(14,2)` y se suman en
 * CENTAVOS enteros para que 0.1 + 0.2 sea 0.3. Es la ÚNICA definición del
 * redondeo de dinero: ningún caso de uso define el suyo (lo vigila la guarda
 * de `money.spec.ts`). Las monedas sin decimales (JPY, KRW…) llegan ya
 * enteras, así que estos redondeos no las alteran. La regla de redondeo por
 * línea a los decimales de la moneda (total = suma de líneas) es
 * `line-rounding.ts` (DX-340); cómo se PINTAN es
 * `shared/format/cldr-format-digits.ts`.
 */

/** Importe → centavos enteros (redondeo al centavo más cercano). */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** Centavos enteros → importe. */
export function fromCents(cents: number): number {
  return cents / 100;
}

/** Importe redondeado a 2 decimales: `fromCents(toCents(amount))`. */
export function round2(amount: number): number {
  return fromCents(toCents(amount));
}
