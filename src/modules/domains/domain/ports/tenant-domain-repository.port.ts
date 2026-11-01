import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { TenantDomainRow } from '../entities/tenant-domain.entity';

export const TENANT_DOMAIN_REPOSITORY = Symbol('TENANT_DOMAIN_REPOSITORY');

/** Resultado de verificar un dominio de la clínica. */
export type MarkVerifiedResult =
  /** Ya enruta. */
  | 'verified'
  /** No estaba verificable: borrado, caducado o ya VERIFIED entretanto. */
  | 'unavailable'
  /** Otra clínica lo verificó antes (índice único de VERIFIED). */
  | 'taken';

/** Resultado de una comprobación periódica de un dominio VERIFIED. */
export interface RecordCheckResult {
  status: 'VERIFIED' | 'DISABLED';
  failedChecks: number;
}

/**
 * Dominios de la clínica del CONTEXTO (`TenantContextService`). tenant_domains
 * no tiene RLS: cada método filtra por ese tenant. Las únicas lecturas o
 * escrituras que miran otras clínicas están dichas en su método.
 */
export interface TenantDomainRepository {
  /**
   * Alta en PENDING. Con `replacing`, en la MISMA transacción retira (soft
   * delete) ese dominio de la clínica: su PENDING caducado del mismo host.
   * DX-360: el alta deja su evento (CREATE TENANT_DOMAIN) en la misma
   * transacción, sin el token.
   */
  create(
    input: {
      host: string;
      verifyToken: string;
      expiresAt: Date;
      replacing?: { id: string; deletedAt: Date };
    },
    audit: AuditRequestContext,
  ): Promise<TenantDomainRow>;
  listByTenant(): Promise<TenantDomainRow[]>;
  findByHostForTenant(host: string): Promise<TenantDomainRow | null>;
  findById(id: string): Promise<TenantDomainRow | null>;
  /**
   * ¿Otra clínica tiene este host VERIFIED y vivo? Solo un booleano: nunca
   * qué clínica.
   */
  isVerifiedByAnotherTenant(host: string): Promise<boolean>;
  /**
   * En UNA transacción: pasa el dominio (PENDING sin caducar a `now`, o
   * DISABLED) a VERIFIED y caduca (`expiresAt = now`) los PENDING vivos del
   * mismo host de OTRAS clínicas: el primero que demuestra el control del DNS
   * se lo queda.
   */
  markVerified(id: string, now: Date): Promise<MarkVerifiedResult>;
  /** Soft delete. false si no existe (o es de otra clínica). */
  softDelete(id: string, now: Date): Promise<boolean>;
  /** El dominio vivo de la clínica sin re-verificación de `round` (o null). */
  findForRecheck(id: string, round: Date): Promise<TenantDomainRow | null>;
  /**
   * Guarda el resultado de la ronda `round` SOLO si el dominio sigue
   * VERIFIED, con `failedChecks` igual a `expectedFailedChecks` y sin
   * comprobar en esta ronda (idempotente: la cola entrega «al menos una
   * vez»). null si no se guardó.
   */
  recordCheck(input: {
    id: string;
    round: Date;
    expectedFailedChecks: number;
    failedChecks: number;
    disable: boolean;
  }): Promise<RecordCheckResult | null>;
}
