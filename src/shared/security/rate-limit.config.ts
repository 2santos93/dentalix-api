/**
 * Límites de peticiones (rate limiting) por política, configurables por
 * entorno. Cada política tiene `RATE_LIMIT_<POLÍTICA>_LIMIT` (peticiones) y
 * `RATE_LIMIT_<POLÍTICA>_TTL_MS` (ventana en ms); ver `.env.example`.
 *
 * El límite se cuenta POR RUTA: las rutas que comparten política tienen cada
 * una su propio balde (p. ej. 20/min en register y otros 20/min en
 * register/verify).
 *
 * - global:        cada ruta, por IP (salvo las sondas /health y
 *                  /health/ready, con @SkipThrottle en HealthController). Red
 *                  de seguridad contra abuso/scraping, holgada porque una
 *                  clínica entera suele salir por UNA IP (NAT).
 * - auth:          register y su verificación; por IP.
 * - refresh:       renovar sesión; por IP. Holgado: la web renueva en cada
 *                  carga de página (DX-062) y una clínica sale por UNA IP; el
 *                  refresh es un JWT firmado, no hay nada que adivinar.
 * - login-burst:   login, por IP. Solo frena avalanchas (cada intento paga
 *                  argon2): cuenta también los aciertos, así que es holgado
 *                  para una clínica entera tras NAT. La fuerza bruta la corta
 *                  el bloqueo por FALLOS de la BD (DX-048,
 *                  `modules/auth/domain/login-lockout.ts`), que vale entre
 *                  réplicas y no cuenta los logins correctos.
 * - invitation:    ver y aceptar invitación por token; por IP (enumeración).
 * - password:      cambio de contraseña, por IP+usuario (contraseña actual).
 * - confirmation:  ver y responder el enlace público de confirmación de cita
 *                  (DX-005); por IP (enumeración de tokens).
 * - invitation-email: invitar y reenviar invitación (DX-088), por clínica +
 *                  usuario (no por IP): cada una manda un email. Primera
 *                  barrera, en memoria de cada réplica; los topes que valen
 *                  entre réplicas están en la BD (EmailOutbox.assertWithinQuota).
 * - password-reset: pedir el enlace, comprobarlo y restablecer la contraseña
 *                  (DX-010); por IP (enumeración de tokens y bombardeo de
 *                  emails). Los topes por destinatario del email están en la
 *                  BD y no se notan en la respuesta (siempre 202).
 * - direct-upload: pedir la autorización de subida directa al bucket
 *                  (`POST …/documents/upload-url`, DX-259), por clínica +
 *                  usuario, como invitation-email: cada una firma un POST
 *                  para subir hasta 20 MB.
 * - anamnesis:     ver y enviar el cuestionario público de anamnesis
 *                  (DX-099), por IP (enumeración de tokens).
 * - anamnesis-token: las mismas rutas, por TOKEN (sin IP): un mismo enlace no
 *                  admite ráfagas de reintentos aunque cambie la IP. La clave
 *                  es el hash del token, nunca el token.
 * - public-files:  servir los avatares (`GET /files/avatars/:name`), por IP
 *                  (DX-259). Ruta anónima que llega al bucket; con la caché
 *                  del navegador (clave versionada, `immutable`) el uso
 *                  normal es bajo, así que frena a quien pida nombres al azar.
 * - patient-import: leer un fichero de importación de pacientes (inspect,
 *                  dry-run y hoja de saldos, SEC-046), por clínica + usuario
 *                  y con UN balde para las tres rutas (no uno por ruta):
 *                  cada lectura puede costar decenas de MB y segundos de CPU.
 *                  El tope de lecturas a la vez es aparte (`ImportReadSlotInterceptor`).
 */
export type RateLimitPolicy =
  | 'auth'
  | 'login-burst'
  | 'invitation'
  | 'password'
  | 'confirmation'
  | 'refresh'
  | 'invitation-email'
  | 'password-reset'
  | 'public-files'
  | 'direct-upload'
  | 'patient-import'
  | 'anamnesis'
  | 'anamnesis-token';

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
  'login-burst': { limit: 60, ttlMs: MINUTE },
  invitation: { limit: 10, ttlMs: MINUTE },
  password: { limit: 5, ttlMs: 15 * MINUTE },
  confirmation: { limit: 20, ttlMs: MINUTE },
  refresh: { limit: 120, ttlMs: MINUTE },
  'invitation-email': { limit: 10, ttlMs: MINUTE },
  'password-reset': { limit: 10, ttlMs: 15 * MINUTE },
  'public-files': { limit: 300, ttlMs: MINUTE },
  'direct-upload': { limit: 60, ttlMs: MINUTE },
  'patient-import': { limit: 10, ttlMs: MINUTE },
  anamnesis: { limit: 20, ttlMs: MINUTE },
  'anamnesis-token': { limit: 10, ttlMs: MINUTE },
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
    'login-burst': rule('login-burst'),
    invitation: rule('invitation'),
    password: rule('password'),
    confirmation: rule('confirmation'),
    refresh: rule('refresh'),
    'invitation-email': rule('invitation-email'),
    'password-reset': rule('password-reset'),
    'public-files': rule('public-files'),
    'direct-upload': rule('direct-upload'),
    'patient-import': rule('patient-import'),
    anamnesis: rule('anamnesis'),
    'anamnesis-token': rule('anamnesis-token'),
  };
}
