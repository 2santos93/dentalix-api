import type { LoginLockoutConfig } from '../login-lockout';

export type AccountBackoffPolicy = Pick<
  LoginLockoutConfig,
  'freeFailures' | 'baseDelayMs' | 'maxDelayMs' | 'failureMemoryMs'
>;

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
   * Cobra un intento a la cuenta ANTES de mirar la contraseña, en UNA
   * sentencia atómica (DX-048): si la cuenta está en espera no cambia nada y
   * devuelve los segundos que faltan; si no, suma un fallo (o empieza de 1 si
   * el último fue hace más de `failureMemoryMs`), deja la espera del backoff
   * que toque (nunca la acorta) y devuelve 0. Así, N intentos simultáneos en
   * cuanto acaba una espera no prueban N contraseñas: solo pasa el primero que
   * llega a la espera. Un login correcto borra después la fila.
   */
  claimAccountAttempt(
    accountKeyHash: string,
    policy: AccountBackoffPolicy,
  ): Promise<number>;

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
