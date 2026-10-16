export const AUDIT_PARTITION_CONFIG = Symbol('AUDIT_PARTITION_CONFIG');

/**
 * Retención mínima del registro de auditoría: 180 meses (15 años). Es la
 * conservación mínima de la historia clínica (Res. 1995/1999 art. 15,
 * modificado por la Res. 839/2017: 15 años desde la última atención), y el
 * registro es la evidencia de quién accedió a ella (custodia y
 * confidencialidad, Res. 1995/1999 arts. 14-16; principio de seguridad y
 * deber de conservar prueba, Ley 1581/2012 arts. 4 y 17). La misma cota la
 * aplica la BD en `audit_events_purge`.
 */
export const AUDIT_MIN_RETENTION_MONTHS = 180;
const DEFAULT_MONTHS_AHEAD = 12;
const MAX_MONTHS_AHEAD = 36;
const DAY_MS = 86_400_000;

export interface AuditPartitionConfig {
  /** Meses que se conservan; nunca menos de AUDIT_MIN_RETENTION_MONTHS. */
  retentionMonths: number;
  /** Particiones aseguradas por delante del mes actual (1..36). */
  monthsAhead: number;
  /** Cada cuánto se reasegura el horizonte; 0 = solo al arrancar. */
  maintenanceIntervalMs: number;
}

function intOr(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : fallback;
}

/**
 * Configuración de particiones y retención de `audit_events` (DX-102), a
 * partir del entorno ya validado por `validateEnv`:
 *
 * - `AUDIT_RETENTION_MONTHS`: retención (default y mínimo 180).
 * - `AUDIT_PARTITIONS_MONTHS_AHEAD`: horizonte de particiones (default 12).
 * - `AUDIT_PARTITIONS_INTERVAL_MS`: reaseguro periódico (default 24 h; 0 con
 *   `NODE_ENV=test`).
 */
export function loadAuditPartitionConfig(
  get: (key: string) => string | undefined,
): AuditPartitionConfig {
  const isTest = get('NODE_ENV') === 'test';
  return {
    retentionMonths: Math.max(
      AUDIT_MIN_RETENTION_MONTHS,
      intOr(get('AUDIT_RETENTION_MONTHS'), AUDIT_MIN_RETENTION_MONTHS),
    ),
    monthsAhead: Math.min(
      MAX_MONTHS_AHEAD,
      Math.max(
        1,
        intOr(get('AUDIT_PARTITIONS_MONTHS_AHEAD'), DEFAULT_MONTHS_AHEAD),
      ),
    ),
    maintenanceIntervalMs: intOr(
      get('AUDIT_PARTITIONS_INTERVAL_MS'),
      isTest ? 0 : DAY_MS,
    ),
  };
}
