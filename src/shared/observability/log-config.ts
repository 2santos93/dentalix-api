/**
 * Configuración del log (DX-023), por entorno:
 *
 * - `LOG_LEVEL`: `silent` | `error` | `warn` | `info` | `debug`. Default
 *   `info`, salvo con `NODE_ENV=test` (jest), donde es `silent` para no
 *   ensuciar la salida de las suites; un test que necesite ver el log lo sube
 *   con `LOG_LEVEL=debug`.
 * - `LOG_FORMAT`: `json` (una línea JSON por evento, la que leen los
 *   recolectores) | `pretty` (legible, para desarrollo). Default `json`.
 *
 * Un valor desconocido aborta el arranque: un typo no debe dejar la API sin log.
 */
export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

export const LOG_FORMATS = ['json', 'pretty'] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

export interface LogConfig {
  level: LogLevelName;
  format: LogFormat;
}

type EnvReader = (key: string) => string | undefined;

function oneOf<T extends string>(
  env: EnvReader,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = env(key)?.trim().toLowerCase();
  if (!raw) return fallback;
  const match = allowed.find((value) => value === raw);
  if (!match) {
    throw new Error(
      `Invalid env var ${key}: expected one of ${allowed.join(', ')}, got "${raw}"`,
    );
  }
  return match;
}

export function loadLogConfig(env: EnvReader): LogConfig {
  const defaultLevel: LogLevelName =
    env('NODE_ENV') === 'test' ? 'silent' : 'info';
  return {
    level: oneOf(env, 'LOG_LEVEL', LOG_LEVELS, defaultLevel),
    format: oneOf(env, 'LOG_FORMAT', LOG_FORMATS, 'json'),
  };
}
