import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

export const JOBS_CONFIG = Symbol('JOBS_CONFIG');

/**
 * Papel del proceso (DX-085), misma imagen y mismo `dist/main.js`:
 * - `api` (default): servidor HTTP; encola trabajos pero no los ejecuta.
 * - `worker`: sin servidor HTTP; ejecuta trabajos y tareas programadas.
 * - `all`: las dos cosas en un proceso (desarrollo o despliegues pequeños).
 */
export type AppRole = 'api' | 'worker' | 'all';

export const DEFAULT_LEASE_SECONDS = 300;
export const DEFAULT_SHUTDOWN_GRACE_MS = 20_000;

export const APP_ROLES: readonly AppRole[] = ['api', 'worker', 'all'];

export interface JobsConfig {
  role: AppRole;
  /** Este proceso reclama y ejecuta trabajos (worker o all). */
  workerEnabled: boolean;
  /** Identifica al worker en `jobs.lockedBy` (host:pid:aleatorio). */
  workerId: string;
  pollIntervalMs: number;
  /** Trabajos a la vez por proceso. */
  concurrency: number;
  /** Arriendo de un trabajo reclamado: si el worker muere, otro lo retoma al vencer. */
  leaseSeconds: number;
  maxAttempts: number;
  retryBaseMs: number;
  /**
   * Cuánto espera el apagado a los trabajos en curso. Menor que el arriendo
   * (validateEnv): si no, otro worker retomaría trabajos aún en curso. El
   * periodo de gracia del orquestador (terminationGracePeriodSeconds en
   * Kubernetes, 30 s por defecto) tiene que ser MAYOR que esto.
   */
  shutdownGraceMs: number;
  /** Cada cuánto renueva el arriendo un trabajo en curso (un tercio del arriendo). */
  heartbeatMs: number;
  /** Días que se conservan los trabajos terminados (COMPLETED y FAILED). */
  retentionDays: number;
  /**
   * DX-220: puerto de la sonda de liveness del worker (`GET /health`, sin
   * rutas de negocio), o null para no abrirla. `JOBS_HEALTH_PORT`.
   */
  healthPort: number | null;
  /** DX-220: versión que el worker apunta en su latido (`APP_VERSION`). */
  version: string | null;
}

/** `APP_VERSION`: lo que cabe en job_workers.version (CHECK). */
export const APP_VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;

export function parseAppRole(raw: string | undefined): AppRole | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return 'api';
  return (APP_ROLES as readonly string[]).includes(value)
    ? (value as AppRole)
    : null;
}

function intOr(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  return value && /^\d{1,9}$/.test(value) ? Number(value) : fallback;
}

function portOrNull(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : null;
}

function versionOrNull(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value && APP_VERSION_PATTERN.test(value) ? value : null;
}

/** A partir del entorno ya validado por `validateEnv` (env.validation.ts). */
export function loadJobsConfig(
  get: (key: string) => string | undefined,
): JobsConfig {
  const role = parseAppRole(get('APP_ROLE')) ?? 'api';
  // En los tests (jest fija NODE_ENV=test) el worker no arranca nunca solo,
  // aunque un .env de desarrollo traiga APP_ROLE=all: los specs lo mueven a
  // mano (runOnce/drain). JOBS_WORKER_IN_TESTS=1 lo permite a propósito.
  const inTests =
    get('NODE_ENV') === 'test' && get('JOBS_WORKER_IN_TESTS') !== '1';
  const leaseSeconds = Math.max(
    10,
    intOr(get('JOBS_LEASE_SECONDS'), DEFAULT_LEASE_SECONDS),
  );
  const host =
    hostname()
      .replace(/[^\w.-]/g, '')
      .slice(0, 60) || 'host';
  return {
    role,
    workerEnabled: role !== 'api' && !inTests,
    workerId: `${host}:${process.pid}:${randomBytes(4).toString('hex')}`,
    pollIntervalMs: Math.max(100, intOr(get('JOBS_POLL_INTERVAL_MS'), 2000)),
    concurrency: Math.max(1, intOr(get('JOBS_CONCURRENCY'), 4)),
    leaseSeconds,
    maxAttempts: Math.max(1, intOr(get('JOBS_MAX_ATTEMPTS'), 5)),
    retryBaseMs: Math.max(1, intOr(get('JOBS_RETRY_BASE_MS'), 30_000)),
    shutdownGraceMs: intOr(
      get('JOBS_SHUTDOWN_GRACE_MS'),
      DEFAULT_SHUTDOWN_GRACE_MS,
    ),
    heartbeatMs: Math.floor((leaseSeconds * 1000) / 3),
    retentionDays: Math.max(1, intOr(get('JOBS_RETENTION_DAYS'), 14)),
    healthPort: portOrNull(get('JOBS_HEALTH_PORT')),
    version: versionOrNull(get('APP_VERSION')),
  };
}
