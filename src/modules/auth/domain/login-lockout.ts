import { createHash } from 'crypto';

/**
 * Bloqueo del login por FALLOS (DX-048, SEC-028). Dos contadores, guardados
 * en la BD para que valgan igual en todas las réplicas (`login_throttles`):
 *
 * - por cuenta (hash del email normalizado): solo cuenta intentos fallidos y
 *   un login correcto lo borra. Sin espera hasta `freeFailures` fallos; desde
 *   ahí, espera creciente `baseDelayMs`·2^k con tope `maxDelayMs` (1, 2, 4, 8…
 *   min, máx. 15). Los fallos se olvidan tras `failureMemoryMs` sin fallar.
 * - por IP (hash): solo cuenta fallos, `ipFailureLimit` por ventana fija de
 *   `ipWindowMs`; al llegar, la IP espera a que acabe la ventana. Holgado
 *   porque una clínica entera sale por UNA IP (NAT), y un éxito no lo
 *   reinicia (un atacante lo limpiaría entrando con su propia cuenta).
 *
 * El contador de la cuenta existe exista o no el email (se indexa por el
 * hash de lo que se escribió), así que el 429 no revela nada.
 */
export interface LoginLockoutConfig {
  freeFailures: number;
  baseDelayMs: number;
  maxDelayMs: number;
  failureMemoryMs: number;
  ipFailureLimit: number;
  ipWindowMs: number;
}

export const LOGIN_LOCKOUT_CONFIG = Symbol('LOGIN_LOCKOUT_CONFIG');

const MINUTE = 60_000;

export const DEFAULT_LOGIN_LOCKOUT: LoginLockoutConfig = {
  freeFailures: 5,
  baseDelayMs: MINUTE,
  maxDelayMs: 15 * MINUTE,
  failureMemoryMs: 60 * MINUTE,
  ipFailureLimit: 100,
  ipWindowMs: 15 * MINUTE,
};

/** Espera (ms) que deja una cuenta con `failures` fallos seguidos. */
export function accountBackoffMs(
  failures: number,
  cfg: Pick<LoginLockoutConfig, 'freeFailures' | 'baseDelayMs' | 'maxDelayMs'>,
): number {
  if (failures < cfg.freeFailures) return 0;
  // Exponente acotado: 2^31 ya supera cualquier tope razonable y evita
  // Infinity con contadores enormes.
  const exponent = Math.min(failures - cfg.freeFailures, 31);
  return Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** exponent);
}

/** Mensaje del 429 del login: idéntico exista o no la cuenta. */
export function loginLockedMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Demasiados intentos. Vuelve a intentarlo en ${minutes} min.`;
}

/** El login está en espera: hay que responder 429 sin mirar la contraseña. */
export class LoginLockedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Login temporarily locked');
    this.name = 'LoginLockedError';
  }
}

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** Normalización del login (trim + minúsculas), igual que LoginUseCase. */
export const normalizeLoginEmail = (email: string): string =>
  email.trim().toLowerCase();

/** Clave del contador de la cuenta: nunca el email en claro. */
export const accountKeyHash = (email: string): string =>
  sha256(`dentalix:login-account:${normalizeLoginEmail(email)}`);

/** Clave del contador de la IP: nunca la IP en claro. */
export const ipKeyHash = (ip: string): string =>
  sha256(`dentalix:login-ip:${ip}`);

type EnvReader = (key: string) => string | undefined;

function positiveInt(env: EnvReader, key: string, fallback: number): number {
  const raw = env(key);
  if (raw == null || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new Error(
      `Invalid env var ${key}: expected a positive integer, got "${raw}"`,
    );
  }
  return Number(raw);
}

export function loadLoginLockoutConfig(env: EnvReader): LoginLockoutConfig {
  const d = DEFAULT_LOGIN_LOCKOUT;
  const cfg: LoginLockoutConfig = {
    freeFailures: positiveInt(
      env,
      'LOGIN_LOCKOUT_FREE_FAILURES',
      d.freeFailures,
    ),
    baseDelayMs: positiveInt(env, 'LOGIN_LOCKOUT_BASE_DELAY_MS', d.baseDelayMs),
    maxDelayMs: positiveInt(env, 'LOGIN_LOCKOUT_MAX_DELAY_MS', d.maxDelayMs),
    failureMemoryMs: positiveInt(
      env,
      'LOGIN_LOCKOUT_RESET_MS',
      d.failureMemoryMs,
    ),
    ipFailureLimit: positiveInt(
      env,
      'LOGIN_IP_FAILURE_LIMIT',
      d.ipFailureLimit,
    ),
    ipWindowMs: positiveInt(env, 'LOGIN_IP_FAILURE_WINDOW_MS', d.ipWindowMs),
  };
  if (cfg.maxDelayMs < cfg.baseDelayMs) {
    throw new Error(
      'Invalid env var LOGIN_LOCKOUT_MAX_DELAY_MS: must be >= LOGIN_LOCKOUT_BASE_DELAY_MS',
    );
  }
  // Si los fallos se olvidaran antes de acabar la espera máxima, el backoff
  // volvería a empezar desde cero en mitad de un ataque.
  if (cfg.failureMemoryMs <= cfg.maxDelayMs) {
    throw new Error(
      'Invalid env var LOGIN_LOCKOUT_RESET_MS: must be > LOGIN_LOCKOUT_MAX_DELAY_MS',
    );
  }
  return cfg;
}
