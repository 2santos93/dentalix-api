import { ForbiddenException } from '@nestjs/common';
import { isTenantPayload } from '../../../shared/crypto/token.service';
import type { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { SessionActor } from '../application/user-sessions.service';
import { SESSION_MESSAGES } from '../domain/user-sessions';

/**
 * DX-137: quién gestiona sesiones. Solo una sesión de clínica normal: un
 * acceso de soporte (break-glass, sin familia de refresh) no ve ni cierra
 * sesiones de nadie.
 */
export function sessionActor(
  req: AuditableRequest,
  tenantContext: TenantContextService,
): SessionActor {
  const user = req.user;
  if (!isTenantPayload(user) || user.breakGlass) {
    throw new ForbiddenException(SESSION_MESSAGES.breakGlass);
  }
  return {
    ...requireAuditRequestContext(req, tenantContext),
    currentSessionId: user.sid ?? null,
  };
}
