/**
 * Apagado ordenado de la API (DX-083). Con SIGTERM, la readiness da 503 al
 * momento y la API espera `SHUTDOWN_DRAIN_MS` (sigue atendiendo) para que el
 * balanceador deje de mandarle peticiones; después cierra el servidor HTTP
 * (espera a las peticiones en vuelo), y por último `app.close()` (despachador
 * de email, worker de trabajos con APP_ROLE=all, `$disconnect` de Prisma).
 * Cierre HTTP + `app.close()` tienen un tope común, `SHUTDOWN_TIMEOUT_MS`:
 * pasado, se cortan las conexiones y el proceso sale con código 1.
 *
 * El periodo de gracia del orquestador (Kubernetes:
 * `terminationGracePeriodSeconds`) tiene que ser MAYOR que
 * `SHUTDOWN_DRAIN_MS + SHUTDOWN_TIMEOUT_MS`; si no, SIGKILL corta a medias.
 */
export interface ShutdownConfig {
  drainMs: number;
  timeoutMs: number;
}

/**
 * Espera de drenado en producción: algo más que lo que tarda el balanceador
 * en dar la instancia por caída (p. ej. sonda cada 5 s × 2 fallos = 10 s).
 * Fuera de producción no hay balanceador: 0, para que Ctrl+C sea inmediato.
 */
export const DEFAULT_SHUTDOWN_DRAIN_MS_PRODUCTION = 15_000;
/**
 * Tope del cierre HTTP + `app.close()`: más que el timeout de una transacción
 * (5 s) y que la espera del worker (`JOBS_SHUTDOWN_GRACE_MS`, 20 s).
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

export const SHUTDOWN_LIMITS = {
  SHUTDOWN_DRAIN_MS: [0, 120_000],
  SHUTDOWN_TIMEOUT_MS: [1_000, 600_000],
} as const satisfies Record<string, readonly [number, number]>;

type Get = (key: string) => string | undefined;

function intOrUndefined(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  return value && /^\d{1,9}$/.test(value) ? Number(value) : undefined;
}

/** Problemas de configuración para `validateEnv` (la API no arranca con ellos). */
export function shutdownConfigProblems(get: Get): string[] {
  const problems: string[] = [];
  for (const [key, [min, max]] of Object.entries(SHUTDOWN_LIMITS)) {
    const raw = get(key);
    if (raw == null || raw.trim() === '') continue;
    const value = intOrUndefined(raw);
    if (value === undefined || value < min || value > max) {
      problems.push(`${key} debe ser un entero entre ${min} y ${max} (ms).`);
    }
  }
  return problems;
}

export function loadShutdownConfig(get: Get): ShutdownConfig {
  const isProd = get('NODE_ENV') === 'production';
  return {
    drainMs:
      intOrUndefined(get('SHUTDOWN_DRAIN_MS')) ??
      (isProd ? DEFAULT_SHUTDOWN_DRAIN_MS_PRODUCTION : 0),
    timeoutMs:
      intOrUndefined(get('SHUTDOWN_TIMEOUT_MS')) ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
  };
}
