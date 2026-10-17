/** Estado guardado en la BD. */
export type TenantDomainStatus = 'PENDING' | 'VERIFIED' | 'DISABLED';

/**
 * Estado que ve la clínica (SEC-009): el guardado, salvo un PENDING pasado
 * su `expiresAt`, que es EXPIRED (ya no se puede verificar ni bloquea a nadie).
 */
export type TenantDomainState = TenantDomainStatus | 'EXPIRED';

/** Una fila de `tenant_domains` tal como la lee el repositorio. */
export interface TenantDomainRow {
  id: string;
  host: string;
  status: TenantDomainStatus;
  verifyToken: string;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  lastCheckedAt: Date | null;
  failedChecks: number;
  disabledAt: Date | null;
  createdAt: Date;
}

/** Lo que devuelve la API: la fila con su estado efectivo. */
export interface TenantDomainRecord extends Omit<TenantDomainRow, 'status'> {
  status: TenantDomainState;
}
