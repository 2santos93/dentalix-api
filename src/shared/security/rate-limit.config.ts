/**
 * Límites de peticiones (rate limiting) por política, configurables por
 * entorno. Cada política tiene `RATE_LIMIT_<POLÍTICA>_LIMIT` (peticiones) y
 * `RATE_LIMIT_<POLÍTICA>_TTL_MS` (ventana en ms); ver `.env.example`.
 *
 * El límite se cuenta POR RUTA: las rutas que comparten política tienen cada
 * una su propio balde (p. ej. 20/min en login y otros 20/min en register).
 *
 * - global:        cada ruta, por IP (salvo las sondas /health y
 *                  /health/ready, con @SkipThrottle en HealthController). Red
 *                  de seguridad contra abuso/scraping, holgada porque una
 *                  clínica entera suele salir por UNA IP (NAT).
 * - auth:          login y register; por IP (frena el "spraying").
 * - refresh:       renovar sesión; por IP. Holgado: la web renueva en cada
 *                  carga de página (DX-062) y una clínica sale por UNA IP; el
 *                  refresh es un JWT firmado, no hay nada que adivinar.
 * - login:         login, por IP+email (fuerza bruta contra una cuenta).
 * - login-account: login, solo por email (fuerza bruta distribuida).
 * - invitation:    ver y aceptar invitación por token; por IP (enumeración).
 * - password:      cambio de contraseña, por IP+usuario (contraseña actual).
 * - confirmation:  ver y responder el enlace público de confirmación de cita
 *                  (DX-005); por IP (enumeración de tokens).
 */
export type RateLimitPolicy =
  | 'auth'
  | 'login'
  | 'login-account'
  | 'invitation'
  | 'password'
  | 'confirmation'
  | 'refresh';

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
  'login-account': { limit: 50, ttlMs: 60 * MINUTE },
  invitation: { limit: 10, ttlMs: MINUTE },
  password: { limit: 5, ttlMs: 15 * MINUTE },
  confirmation: { limit: 20, ttlMs: MINUTE },
  refresh: { limit: 120, ttlMs: MINUTE },
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
    const prefix = `RATE_LIMIT_${name.toUpperCase().replace('-', '_')}`;
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
    'login-account': rule('login-account'),
    invitation: rule('invitation'),
    password: rule('password'),
    confirmation: rule('confirmation'),
    refresh: rule('refresh'),
  };
}
