/**
 * DX-149-quater: límites del restablecimiento de contraseña (endpoint
 * público). Los lee `AuthModule` del entorno ya validado por `validateEnv`.
 */
export interface PasswordResetLimits {
  /**
   * Restablecimientos con su trabajo en curso (y su transacción abierta) a la
   * vez por proceso (`PASSWORD_RESET_MAX_CONCURRENCY`, 1..100). Sin él, una
   * inundación desde muchas IP (el rate limit es por IP) abre tantas
   * transacciones como peticiones y agota el pool de las clínicas.
   */
  concurrency: number;
  /**
   * Cuántos pueden esperar turno a la vez por proceso
   * (`PASSWORD_RESET_MAX_QUEUE`, 1..10000). Pasado, el resto se descarta en
   * silencio (THROTTLED `QUEUE_FULL`): la memoria y la espera no crecen sin
   * fin. Con 1000 y 150–400 restablecimientos/s, la cola son unos segundos.
   */
  maxQueue: number;
  /**
   * Quien lleva más de esto esperando turno se descarta al llegarle
   * (THROTTLED `QUEUE_EXPIRED`): su enlace llegaría cuando ya se rindió.
   */
  queueMaxWaitMs: number;
  /**
   * Enlaces al día POR USUARIO, sumando todas sus clínicas
   * (`PASSWORD_RESET_USER_DAILY_LIMIT`, 1..20). Propio del restablecimiento:
   * no se mueve si se sube el tope de correos por destinatario.
   */
  userDailyLimit: number;
}

export const PASSWORD_RESET_LIMITS = Symbol('PASSWORD_RESET_LIMITS');

/** Reloj (ms) de la cola de turnos; los tests lo sustituyen. */
export const PASSWORD_RESET_CLOCK = Symbol('PASSWORD_RESET_CLOCK');

export const DEFAULT_PASSWORD_RESET_LIMITS: Readonly<PasswordResetLimits> = {
  concurrency: 4,
  maxQueue: 1000,
  queueMaxWaitMs: 30_000,
  userDailyLimit: 5,
};

function intOr(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  return value ? Number(value) : fallback;
}

/** Los límites del entorno (ya validado); vacío = el default. */
export function loadPasswordResetLimits(
  get: (key: string) => string | undefined,
): PasswordResetLimits {
  const d = DEFAULT_PASSWORD_RESET_LIMITS;
  return {
    concurrency: intOr(get('PASSWORD_RESET_MAX_CONCURRENCY'), d.concurrency),
    maxQueue: intOr(get('PASSWORD_RESET_MAX_QUEUE'), d.maxQueue),
    queueMaxWaitMs: d.queueMaxWaitMs,
    userDailyLimit: intOr(
      get('PASSWORD_RESET_USER_DAILY_LIMIT'),
      d.userDailyLimit,
    ),
  };
}
