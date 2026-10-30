import type { ClinicRole } from '@prisma/client';
import type { AuditEventDraft } from '../../audit/domain/audit-event';
import {
  auditDraftFromContext,
  type AuditRequestContext,
  type AuditRequestMeta,
} from '../../audit/domain/audit-request-context';

/**
 * DX-359: eventos de las invitaciones al personal. Ninguno lleva el token, su
 * hash, el email ni el nombre de la persona invitada: el `resourceId` es la
 * invitación y el rol es lo único que dice a qué accede.
 */
export function invitationCreatedAuditEvent(
  ctx: AuditRequestContext,
  invitationId: string,
  role: ClinicRole,
): AuditEventDraft {
  return auditDraftFromContext(ctx, {
    action: 'CREATE',
    resourceType: 'STAFF_INVITATION',
    resourceId: invitationId,
    metadata: { reason: 'INVITATION_SENT', staffAccess: { after: { role } } },
  });
}

/** «Reenviar invitación»: token y caducidad nuevos (DX-088). */
export function invitationResentAuditEvent(
  ctx: AuditRequestContext,
  invitationId: string,
): AuditEventDraft {
  return auditDraftFromContext(ctx, {
    action: 'UPDATE',
    resourceType: 'STAFF_INVITATION',
    resourceId: invitationId,
    metadata: { reason: 'INVITATION_RESENT' },
  });
}

/**
 * Invitación pendiente que deja de valer: el ADMIN la retira (`REVOKED`) o
 * una invitación nueva al mismo correo la sustituye (`REPLACED`).
 */
export function invitationRevokedAuditEvent(
  ctx: AuditRequestContext,
  invitationId: string,
  why: 'REVOKED' | 'REPLACED',
): AuditEventDraft {
  return auditDraftFromContext(ctx, {
    action: 'VOID',
    resourceType: 'STAFF_INVITATION',
    resourceId: invitationId,
    metadata: {
      reason: `INVITATION_${why}`,
      statusChange: { from: 'PENDING', to: 'REVOKED' },
    },
  });
}

/**
 * Aceptación de una invitación (cuenta nueva, existente o reclamada): el alta
 * del miembro la hace él mismo, con el rol de la invitación y sus sedes
 * (`null` = todas). Una membresía que estaba de baja vuelve a ACTIVE.
 */
export function invitationAcceptedAuditEvent(
  request: AuditRequestMeta | null,
  accepted: {
    tenantId: string;
    invitationId: string;
    userId: string;
    role: ClinicRole;
    locationIds: string[] | null;
    reactivated: boolean;
  },
): AuditEventDraft {
  return {
    tenantId: accepted.tenantId,
    locationId: null,
    actor: { kind: 'user', userId: accepted.userId, role: accepted.role },
    patient: null,
    requestId: request?.requestId ?? null,
    ip: request?.ip ?? null,
    userAgent: request?.userAgent ?? null,
    action: 'CREATE',
    resourceType: 'STAFF_MEMBER',
    resourceId: accepted.userId,
    metadata: {
      reason: 'INVITATION_ACCEPTED',
      params: { invitationId: accepted.invitationId },
      staffAccess: {
        after: { role: accepted.role, locationIds: accepted.locationIds },
      },
      ...(accepted.reactivated
        ? { statusChange: { from: 'INACTIVE', to: 'ACTIVE' } }
        : {}),
    },
  };
}
