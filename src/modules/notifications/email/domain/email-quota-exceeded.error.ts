/**
 * Tope anti-abuso alcanzado (DX-088, revisión B1): demasiados emails al mismo
 * destinatario o de la misma clínica. Error de dominio; la presentación lo
 * convierte en 429 con `Retry-After`. El mensaje va en español, para la web.
 */
export class EmailQuotaExceededError extends Error {
  readonly name = 'EmailQuotaExceededError';

  constructor(
    message: string,
    /** Segundos hasta que se puede volver a intentar. */
    readonly retryAfterSeconds: number,
  ) {
    super(message);
  }
}
