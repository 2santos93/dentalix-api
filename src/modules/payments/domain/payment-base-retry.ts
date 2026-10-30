/**
 * DX-380 (OPS-045): reintento escalonado de un abono que se quedó sin base de
 * imputación (o sin su tasa congelada). Cada intento fallido espera más que el
 * anterior, hasta un día: un abono cuya fecha no tiene tasa no se reintenta
 * cada minuto para siempre ni vuelve a llamar al proveedor en cada pasada.
 */

/** Por qué falló el último intento. */
export type PaymentBaseRetryReason =
  /** Su moneda no tiene tasa ese día (manual sin registrar, proveedor caído, tiempo agotado o presupuesto). */
  | 'NO_RATE'
  /** Cualquier otro fallo (BD, programación); se registra con su tipo. */
  | 'ERROR';

/** Espera tras el intento fallido 1, 2, 3, 4 y 5 en adelante. */
export const PAYMENT_BASE_RETRY_DELAYS_MS: readonly number[] = [
  60_000, // 1 min
  5 * 60_000, // 5 min
  30 * 60_000, // 30 min
  2 * 60 * 60_000, // 2 h
  24 * 60 * 60_000, // 24 h (tope)
];

/**
 * Cuánto esperar antes del siguiente intento cuando ya han fallado
 * `attempts` (≥ 1): 1 min, 5, 30, 2 h y, desde el quinto, 24 h.
 */
export function paymentBaseRetryDelayMs(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`attempts debe ser un entero >= 1 (${attempts})`);
  }
  const delays = PAYMENT_BASE_RETRY_DELAYS_MS;
  return delays[Math.min(attempts, delays.length) - 1];
}

/** Horas sin base tras las que el ADMIN ve el aviso de abonos sin tasa. */
export const PAYMENT_BASE_BACKLOG_HOURS = 24;
