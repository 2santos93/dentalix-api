import type {
  TenantDomainRecord,
  TenantDomainRow,
  TenantDomainState,
} from '../entities/tenant-domain.entity';

/**
 * SEC-009: un PENDING se puede verificar durante 72 h desde el alta. Después
 * está EXPIRED. La BD tiene el mismo default para `expiresAt` (migración
 * 20261017234400_sec009_tenant_domain_verified_unique).
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

const HOUR_MS = 60 * 60 * 1000;

/**
 * Ronda de la re-verificación periódica: la hora UTC en curso (truncada). Un
 * barrido repetido en la misma hora (reintento del trabajo, arriendo perdido,
 * tick atrasado) produce la misma ronda, así que la idempotencyKey lo
 * deduplica y no se cuenta dos veces el mismo fallo en una hora.
 */
export function recheckRound(now: Date): Date {
  return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
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

/** DX-220 (OPS-033): rondas con menos dominios que esto no activan el freno. */
export const SUSPECT_ROUND_MIN_DOMAINS = 4;

/**
 * Freno del barrido (DX-220, OPS-033): si en una ronda fallan (sin el TXT
 * con el token, o sin respuesta del DNS) más de la mitad de los dominios, y son al menos
 * SUSPECT_ROUND_MIN_DOMAINS, lo probable es que falle el DNS propio (o la
 * red de salida), no que medio parque de clínicas haya perdido su dominio a
 * la vez: la ronda no cuenta para ninguno. Con pocos dominios una mayoría de
 * fallos es normal (dos de tres, por ejemplo) y no frena.
 */
export function isSuspectRound(domains: number, failed: number): boolean {
  return domains >= SUSPECT_ROUND_MIN_DOMAINS && failed * 2 > domains;
}
