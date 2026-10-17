import type {
  TenantDomainRecord,
  TenantDomainRow,
  TenantDomainState,
} from '../entities/tenant-domain.entity';

/**
 * SEC-009: un PENDING se puede verificar durante 72 h desde el alta. Después
 * está EXPIRED. La BD tiene el mismo default para `expiresAt` (migración
 * 20261017233300_sec009_tenant_domain_verified_unique).
 */
export const PENDING_DOMAIN_TTL_MS = 72 * 60 * 60 * 1000;

/** Comprobaciones fallidas seguidas antes de desactivar un dominio VERIFIED. */
export const DEFAULT_RECHECK_MAX_FAILURES = 3;
export const RECHECK_MAX_FAILURES_LIMIT = 20;

/** Nombre DNS del registro TXT que demuestra el control del dominio. */
export function verificationRecordName(host: string): string {
  return `_dentalix-verify.${host}`;
}

export function hasVerificationToken(
  records: string[],
  verifyToken: string,
): boolean {
  return records.some((r) => r.includes(verifyToken));
}

export function pendingExpiresAt(now: Date): Date {
  return new Date(now.getTime() + PENDING_DOMAIN_TTL_MS);
}

export function isExpired(
  row: Pick<TenantDomainRow, 'status' | 'expiresAt'>,
  now: Date,
): boolean {
  return (
    row.status === 'PENDING' &&
    row.expiresAt !== null &&
    row.expiresAt.getTime() <= now.getTime()
  );
}

export function domainState(
  row: Pick<TenantDomainRow, 'status' | 'expiresAt'>,
  now: Date,
): TenantDomainState {
  return isExpired(row, now) ? 'EXPIRED' : row.status;
}

export function toDomainRecord(
  row: TenantDomainRow,
  now: Date,
): TenantDomainRecord {
  return { ...row, status: domainState(row, now) };
}

/**
 * Resultado de una comprobación periódica (domains.recheck): con el TXT se
 * reinicia la cuenta; sin él, suma un fallo y al llegar a `maxFailures` el
 * dominio pasa a DISABLED (deja de enrutar).
 */
export function nextCheckState(
  failedChecks: number,
  found: boolean,
  maxFailures: number,
): { failedChecks: number; disable: boolean } {
  if (found) return { failedChecks: 0, disable: false };
  const failed = failedChecks + 1;
  return { failedChecks: failed, disable: failed >= maxFailures };
}
