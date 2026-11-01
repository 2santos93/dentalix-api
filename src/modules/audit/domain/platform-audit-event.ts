/**
 * Acciones de un superadmin sobre la PLATAFORMA, sin clínica (DX-220): van a
 * `platform_audit_events`, nunca a `audit_events` (que exige tenant). La
 * lista coincide con los CHECK de la tabla (DX-359 añade el MFA y el cambio
 * de contraseña; DX-330, el mínimo de conservación aplicado a una clínica).
 */
export type PlatformAuditAction =
  | 'JOB_RETRIED'
  | 'MFA_ENROLLMENT_STARTED'
  | 'MFA_ENABLED'
  | 'PASSWORD_CHANGE'
  | 'CLINICAL_RETENTION_MINIMUM_APPLIED';

export type PlatformAuditResourceType = 'JOB' | 'USER' | 'TENANT';

/** Quién y desde dónde (la sesión de plataforma de la petición). */
export interface PlatformAuditActor {
  userId: string;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Evento de plataforma de DX-359. Sin metadata: el alta del MFA y el cambio de
 * contraseña son solo el hecho (ni secreto TOTP, ni código, ni otpauth URI,
 * ni nada de la contraseña).
 */
export interface OwnAccountAuditEventDraft {
  actor: PlatformAuditActor;
  action: 'MFA_ENROLLMENT_STARTED' | 'MFA_ENABLED' | 'PASSWORD_CHANGE';
  resourceType: 'USER';
  resourceId: string;
}

/**
 * Evento de plataforma de DX-330: una clínica pasó de `before` a `after` años
 * de conservación por el mínimo de plataforma. Solo los dos plazos.
 */
export interface ClinicalRetentionMinimumAppliedDraft {
  actor: PlatformAuditActor;
  action: 'CLINICAL_RETENTION_MINIMUM_APPLIED';
  resourceType: 'TENANT';
  resourceId: string;
  metadata: { before: number; after: number };
}

export type PlatformAuditEventDraft =
  OwnAccountAuditEventDraft | ClinicalRetentionMinimumAppliedDraft;

/** El superadmin actúa sobre su propia cuenta (MFA, contraseña). */
export function ownPlatformAccountEvent(
  actor: PlatformAuditActor,
  action: OwnAccountAuditEventDraft['action'],
): OwnAccountAuditEventDraft {
  return { actor, action, resourceType: 'USER', resourceId: actor.userId };
}
