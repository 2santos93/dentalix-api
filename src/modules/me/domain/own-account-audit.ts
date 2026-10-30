import type { AuditEventDraft } from '../../audit/domain/audit-event';
import {
  auditDraftFromContext,
  type AuditRequestContext,
  type AuditRequestMeta,
} from '../../audit/domain/audit-request-context';
import {
  ownPlatformAccountEvent,
  type PlatformAuditEventDraft,
} from '../../audit/domain/platform-audit-event';
import {
  isTenantPayload,
  type JwtPayload,
} from '../../../shared/crypto/token.service';

/**
 * DX-359: dónde queda un cambio de la cuenta propia. Con sesión de clínica,
 * en la auditoría de ESA clínica; con sesión de plataforma (superadmin, sin
 * clínica), en `platform_audit_events`.
 */
export type OwnAccountAuditEvent =
  | { kind: 'tenant'; event: AuditEventDraft }
  | { kind: 'platform'; event: PlatformAuditEventDraft };

/**
 * `PATCH /me`: el miembro cambia su propio nombre. Solo el nombre del campo,
 * nunca el valor (como cualquier UPDATE).
 */
export function ownNameAuditEvent(ctx: AuditRequestContext): AuditEventDraft {
  return auditDraftFromContext(ctx, {
    action: 'UPDATE',
    resourceType: 'STAFF_MEMBER',
    resourceId: ctx.actor.userId,
    metadata: { reason: 'OWN_NAME_CHANGED', changedFields: ['fullName'] },
  });
}

/**
 * `POST /me/password`: solo el hecho y que las demás sesiones se cerraron.
 * Ni la contraseña, ni su hash, ni la versión de sesión. `claims` son los
 * ACTUALES de la sesión (rol vigente).
 */
export function passwordChangeAuditEvent(
  claims: JwtPayload,
  request: AuditRequestMeta,
): OwnAccountAuditEvent {
  if (!isTenantPayload(claims)) {
    return {
      kind: 'platform',
      event: ownPlatformAccountEvent(
        { userId: claims.sub, ...request },
        'PASSWORD_CHANGE',
      ),
    };
  }
  return {
    kind: 'tenant',
    event: auditDraftFromContext(
      {
        tenantId: claims.tenantId,
        locationId: null,
        actor: { userId: claims.sub, role: claims.role },
        ...request,
      },
      {
        action: 'PASSWORD_CHANGE',
        resourceType: 'SESSION',
        resourceId: null,
        metadata: { reason: 'SESSIONS_REVOKED' },
      },
    ),
  };
}
