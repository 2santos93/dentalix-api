import type { AuditEventDraft } from '../../audit/domain/audit-event';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../audit/domain/config-audit';
import type { TenantDomainRow } from './entities/tenant-domain.entity';

/**
 * DX-360: alta de un dominio propio (`POST /domains`), en PENDING. El host y
 * el estado; NUNCA el token de verificación (es lo que prueba la propiedad
 * del dominio). Si sustituye a su PENDING caducado, el id del retirado.
 */
export function domainRegisteredAuditEvent(
  ctx: AuditRequestContext,
  row: Pick<TenantDomainRow, 'id' | 'host' | 'status'>,
  replacedId: string | null,
): AuditEventDraft {
  return configAuditEvent(ctx, {
    action: 'CREATE',
    resourceType: 'TENANT_DOMAIN',
    resourceId: row.id,
    reason: 'DOMAIN_REGISTERED',
    after: { host: row.host, status: row.status },
    ...(replacedId
      ? { extra: { params: { replacedDomainId: replacedId } } }
      : {}),
  });
}
