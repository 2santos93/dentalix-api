import type { AuditEventDraft } from '../../audit/domain/audit-event';
import {
  auditDraftFromContext,
  type AuditRequestContext,
} from '../../audit/domain/audit-request-context';

/**
 * DX-021: eventos de la verificación en dos pasos en la auditoría de la
 * clínica de la sesión. Solo el hecho (un código de motivo): ni el secreto,
 * ni el otpauth URI, ni códigos TOTP o de recuperación.
 */
export type UserMfaAuditReason =
  | 'MFA_ENROLLMENT_STARTED'
  | 'MFA_ENABLED'
  | 'MFA_DISABLED'
  | 'MFA_RECOVERY_CODES_REGENERATED';

export function userMfaAuditEvent(
  ctx: AuditRequestContext,
  reason: UserMfaAuditReason,
): AuditEventDraft {
  return auditDraftFromContext(ctx, {
    action: 'UPDATE',
    resourceType: 'STAFF_MEMBER',
    resourceId: ctx.actor.userId,
    metadata: { reason },
  });
}

/** Motivo del LOGIN (o LOGIN_FAILED) que cierra el paso del segundo factor. */
export type MfaLoginReason =
  'MFA_TOTP' | 'MFA_RECOVERY_CODE' | 'MFA_ENROLLED' | 'INVALID_MFA_CODE';
