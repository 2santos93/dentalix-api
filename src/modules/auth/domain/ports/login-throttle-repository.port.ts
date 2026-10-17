export const LOGIN_THROTTLE_REPOSITORY = Symbol('LOGIN_THROTTLE_REPOSITORY');

/** Las dos filas que mira un intento de login (DX-048). */
export interface LoginThrottleKeys {
  accountKeyHash: string;
  ipKeyHash: string;
}

/**
 * Contadores de fallos del login en `login_throttles` (tabla de plataforma,
 * sin RLS). Las escrituras son atómicas en la BD (varias réplicas a la vez) y
 * TODAS las horas son las de la BD, no las de la réplica.
 */
export interface LoginThrottleRepository {
  /**
   * Segundos de espera (redondeados hacia arriba) de la cuenta o de la IP, el
   * mayor de los dos. 0 si ninguna está en espera.
   */
  retryAfterSeconds(keys: LoginThrottleKeys): Promise<number>;

  /**
   * Suma un fallo a la cuenta, o empieza de 1 si el último fue hace más de
   * `failureMemoryMs`. Devuelve los fallos seguidos tras sumar.
   */
  recordAccountFailure(
    accountKeyHash: string,
    failureMemoryMs: number,
  ): Promise<number>;

  /** Deja la cuenta en espera `delayMs` desde ahora (nunca la acorta). */
  blockAccount(accountKeyHash: string, delayMs: number): Promise<void>;

  /**
   * Suma un fallo a la IP en su ventana fija (una nueva si la anterior acabó)
   * y, al llegar a `limit`, la deja en espera hasta el final de la ventana.
   */
  recordIpFailure(
    ipKeyHash: string,
    limit: number,
    windowMs: number,
  ): Promise<void>;

  /** Borra el contador de la cuenta (login correcto o desbloqueo). */
  clearAccount(accountKeyHash: string): Promise<void>;

  /** Hasta cuándo espera la cuenta, o `null` si no está en espera. */
  accountBlockedUntil(accountKeyHash: string): Promise<Date | null>;
}
