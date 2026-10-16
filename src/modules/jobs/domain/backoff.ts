/** Tope de espera entre dos intentos de un trabajo. */
export const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

/**
 * Espera antes del siguiente intento tras el fallo número `attempt` (1, 2…):
 * `base · 2^(attempt-1)`, con tope de 1 h. Determinista a propósito: los
 * trabajos de la cola no compiten por un proveedor común como para necesitar
 * jitter, y así el test fija la hora exacta del reintento.
 */
export function jobRetryDelayMs(attempt: number, baseMs: number): number {
  const base = Math.max(1, baseMs);
  const exponent = Math.min(Math.max(0, attempt - 1), 30);
  return Math.min(base * 2 ** exponent, MAX_RETRY_DELAY_MS);
}

/**
 * Descripción del error de un trabajo SIN su mensaje (puede llevar datos del
 * paciente o la URL de un proveedor con su clave): solo el tipo y un código
 * corto (`code` de Node o de Prisma), acotado a 200 caracteres. Es lo que se
 * guarda en `jobs.lastError` y lo que sale en el log.
 */
export function describeJobError(err: unknown): string {
  if (!(err instanceof Error)) {
    return 'UnknownError';
  }
  const { code } = err as Error & { code?: unknown };
  const safeCode =
    typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : null;
  const name = /^[A-Za-z0-9_]{1,60}$/.test(err.name) ? err.name : 'Error';
  return (safeCode ? `${name} ${safeCode}` : name).slice(0, 200);
}
