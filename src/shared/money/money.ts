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
 * Promedio de un importe en céntimos enteros, exacto (DX-488): la mitad hacia
 * arriba de `totalCents ÷ count`, `floor((2·totalCents + count) / (2·count))`,
 * en enteros (BigInt), así un empate (1.005, 2.135, 4.015) nunca se pierde
 * por coma flotante. En negativos la mitad sube hacia +∞, como `Math.round`.
 * `count` es un entero ≥ 1: sin elementos no hay promedio (lo decide quien
 * llama: 0 o `null`). El dinero nunca suma un épsilon para redondear.
 */
export function averageCents(totalCents: number, count: number): number {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`Promedio sin elementos: count = ${count}.`);
  }
  if (!Number.isInteger(totalCents)) {
    throw new RangeError(`Céntimos no enteros: ${totalCents}.`);
  }
  const numerator = 2n * BigInt(totalCents) + BigInt(count);
  const denominator = 2n * BigInt(count);
  // BigInt trunca hacia 0: `floor` exacto también con numerador negativo.
  const quotient = numerator / denominator;
  const floored = numerator % denominator < 0n ? quotient - 1n : quotient;
  return Number(floored);
}

/** Promedio de un importe (`total ÷ count`) con `averageCents`, en unidades. */
export function averageAmount(total: number, count: number): number {
  return fromCents(averageCents(toCents(total), count));
}
