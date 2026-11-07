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

/**
 * Céntimos que llegan como número (suma de una consulta SQL) → céntimos
 * enteros (DX-488). Es el mismo `Math.round` de siempre, ahora en un solo sitio.
 */
export function roundCents(cents: number): number {
  return Math.round(cents);
}

/**
 * Un importe como texto con `digits` decimales (`toFixed`), para claves de
 * idempotencia, SQL `numeric`, CSV y presupuestos (DX-488). No redondea por
 * línea: el importe ya está redondeado; esto solo lo escribe.
 */
export function amountText(amount: number, digits: number): string {
  return amount.toFixed(digits);
}

/**
 * Redondeo a 2 decimales con `Number.EPSILON` de ventaja, mitad hacia arriba
 * (DX-488). Solo lo usa el informe de producción por procedimiento. Difiere de
 * `round2` en los empates de coma flotante (1.005 → 1.01 aquí, 1 en `round2`):
 * se conserva tal cual por no cambiar importes ya informados; unificarlo con
 * `round2` es una decisión pendiente (ver README «Redondeo de importes»).
 */
export function round2WithEpsilon(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}
