import {
  isTenantPayload,
  type JwtPayload,
} from '../../../shared/crypto/token.service';
import type { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { currentRequestId } from '../../../shared/observability/request-context';
import type { AuditRequestContext } from '../domain/audit-request-context';

/** Lo que hace falta de la petición (Express). */
export interface AuditableRequest {
  user: JwtPayload;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Contexto de auditoría de la petición en curso; `undefined` fuera de una
 * sesión de clínica (no pasa detrás del RolesGuard).
 */
export function auditRequestContext(
  req: AuditableRequest,
  tenantContext: TenantContextService,
): AuditRequestContext | undefined {
  const tenantId = tenantContext.getTenantId();
  if (!tenantId || !isTenantPayload(req.user)) return undefined;
  const userAgent = req.headers['user-agent'];
  return {
    tenantId,
    locationId: tenantContext.getLocationId() ?? null,
    actor: { userId: req.user.sub, role: req.user.role },
    requestId: currentRequestId() ?? null,
    ip: req.ip ?? null,
    userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
  };
}
