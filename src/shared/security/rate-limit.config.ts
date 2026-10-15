/**
 * Límites de peticiones (rate limiting) por política, configurables por
 * entorno. Cada política tiene `RATE_LIMIT_<POLÍTICA>_LIMIT` (peticiones) y
 * `RATE_LIMIT_<POLÍTICA>_TTL_MS` (ventana en ms); ver `.env.example`.
 *
 * - global:     toda la API, por IP. Red de seguridad contra abuso/scraping,
 *               holgada porque una clínica entera suele salir por UNA IP (NAT).
 * - auth:       login/register/refresh, por IP (frena el "spraying" de emails).
 * - login:      login, por IP+email (fuerza bruta contra una cuenta).
 * - invitation: ver/aceptar invitación por token, por IP (enumeración).
 * - password:   cambio de contraseña, por IP (adivinar la contraseña actual).
 */
export type RateLimitPolicy = 'auth' | 'login' | 'invitation' | 'password';

export interface RateLimitRule {
  limit: number;
  ttlMs: number;
}

export type RateLimitConfig = Record<'global' | RateLimitPolicy, RateLimitRule>;

export const RATE_LIMIT_CONFIG = Symbol('RATE_LIMIT_CONFIG');

const MINUTE = 60_000;

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  global: { limit: 1000, ttlMs: MINUTE },
  auth: { limit: 20, ttlMs: MINUTE },
  login: { limit: 5, ttlMs: 15 * MINUTE },
  invitation: { limit: 10, ttlMs: MINUTE },
  password: { limit: 5, ttlMs: 15 * MINUTE },
};

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

export function loadRateLimitConfig(env: EnvReader): RateLimitConfig {
  const rule = (name: keyof RateLimitConfig): RateLimitRule => {
    const prefix = `RATE_LIMIT_${name.toUpperCase()}`;
    const fallback = DEFAULT_RATE_LIMITS[name];
    return {
      limit: positiveInt(env, `${prefix}_LIMIT`, fallback.limit),
      ttlMs: positiveInt(env, `${prefix}_TTL_MS`, fallback.ttlMs),
    };
  };
  return {
    global: rule('global'),
    auth: rule('auth'),
    login: rule('login'),
    invitation: rule('invitation'),
    password: rule('password'),
  };
}
