/** Intentos totales por email: el 3.er fallo lo deja FAILED. */
export const MAX_EMAIL_ATTEMPTS = 3;

/**
 * Espera antes del siguiente intento tras el fallo número `attempt` (1, 2…):
 * backoff exponencial `base · 2^(attempt-1)` (1 min, 2 min con la base por
 * defecto), con tope de 1 h.
 */
export function retryDelayMs(attempt: number, baseMs: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(baseMs * 2 ** exponent, 60 * 60 * 1000);
}

/**
 * Descripción del error SIN su mensaje: el de un proveedor SMTP suele repetir
 * el destinatario ("550 5.1.1 <ana@…>: user unknown"). Solo el tipo y el
 * código (SMTP `responseCode` o `code` de Node), acotado a 200 caracteres.
 */
export function describeDeliveryError(err: unknown): string {
  if (!(err instanceof Error)) {
    return 'UnknownError';
  }
  const details = err as Error & { responseCode?: unknown; code?: unknown };
  const code =
    typeof details.responseCode === 'number'
      ? String(details.responseCode)
      : typeof details.code === 'string' &&
          /^[A-Z0-9_]{1,40}$/.test(details.code)
        ? details.code
        : null;
  const name = /^[A-Za-z0-9_]{1,60}$/.test(err.name) ? err.name : 'Error';
  return (code ? `${name} ${code}` : name).slice(0, 200);
}
