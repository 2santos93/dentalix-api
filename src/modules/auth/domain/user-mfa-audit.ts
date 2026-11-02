import type { AuditEventDraft } from '../../audit/domain/audit-event';
import {
  auditDraftFromContext,
  type AuditRequestContext,
} from '../../audit/domain/audit-request-context';
import {
  ownPlatformAccountEvent,
  type OwnAccountAuditEventDraft,
  type PlatformAuditActor,
} from '../../audit/domain/platform-audit-event';
import type { MfaResetReason } from './user-mfa';

/**
 * DX-021: eventos de la verificación en dos pasos en la auditoría de la
 * clínica de la sesión. Solo el hecho (un código de motivo): ni el secreto,
 * ni el otpauth URI, ni códigos TOTP o de recuperación.
 */
export type UserMfaAuditReason =
  | 'MFA_ENROLLMENT_STARTED'
  | 'MFA_ENABLED'
  | 'MFA_DISABLED'
  | 'MFA_RECOVERY_CODES_REGENERATED'
  | 'MFA_TRUSTED_DEVICE_ADDED'
  | 'MFA_TRUSTED_DEVICE_USED'
  | 'MFA_TRUSTED_DEVICES_REVOKED';

/** DX-021-bis: quien actúa, en una clínica o en plataforma (sin clínica). */
export type MfaActorContext = AuditRequestContext | PlatformAuditActor;

export type MfaAuditDraft = AuditEventDraft | OwnAccountAuditEventDraft;

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

/** DX-021-bis: el superadmin va a `platform_audit_events`, nunca a una clínica. */
export function mfaAuditEvent(
  ctx: MfaActorContext,
  reason:
    'MFA_ENROLLMENT_STARTED' | 'MFA_ENABLED' | 'MFA_RECOVERY_CODES_REGENERATED',
): MfaAuditDraft {
  return 'tenantId' in ctx
    ? userMfaAuditEvent(ctx, reason)
    : ownPlatformAccountEvent(ctx, reason);
}

/** DX-021-bis: un ADMIN restablece la de otro miembro; el motivo es un código. */
export function mfaResetAuditEvent(
  ctx: AuditRequestContext,
  targetUserId: string,
  reason: MfaResetReason | 'REFUSED',
): AuditEventDraft {
  return auditDraftFromContext(ctx, {
    action: 'UPDATE',
    resourceType: 'STAFF_MEMBER',
    resourceId: targetUserId,
    metadata: { reason: `MFA_RESET_${reason}` },
  });
}

/** Motivo del LOGIN (o LOGIN_FAILED) que cierra el paso del segundo factor. */
export type MfaLoginReason =
  'MFA_TOTP' | 'MFA_RECOVERY_CODE' | 'MFA_ENROLLED' | 'INVALID_MFA_CODE';
