export const DOMAIN_RECHECK_SOURCE = Symbol('DOMAIN_RECHECK_SOURCE');

export interface VerifiedDomainRef {
  id: string;
  tenantId: string;
  /** Cursor del barrido: único entre los VERIFIED vivos. */
  host: string;
  /**
   * DX-220: el barrido consulta el DNS de toda la ronda para el freno
   * (isSuspectRound) y compara el TXT con el token. El token es público
   * (está publicado en el DNS) y nunca va al payload ni a los logs.
   */
  verifyToken: string;
}

/**
 * Lectura de PLATAFORMA para el barrido de re-verificación (SEC-009): los
 * dominios VERIFIED vivos de TODAS las clínicas vivas: ids, host y token. Es la única
 * lectura de tenant_domains sin tenant aparte del ruteo
 * (TenantResolverService); cada comprobación corre después bajo el tenant
 * de su dominio.
 */
export interface DomainRecheckSource {
  /**
   * Hasta `limit` dominios con host mayor que `afterHost`, por host (índice
   * tenant_domains_verified_host_key: mismo predicado y mismo orden).
   */
  listVerified(
    afterHost: string | null,
    limit: number,
  ): Promise<VerifiedDomainRef[]>;
}
