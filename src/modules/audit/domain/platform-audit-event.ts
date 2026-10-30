/**
 * Acciones de un superadmin sobre la PLATAFORMA, sin clínica (DX-220): van a
 * `platform_audit_events`, nunca a `audit_events` (que exige tenant). La
 * lista coincide con los CHECK de la tabla (DX-359 añade el MFA y el cambio
 * de contraseña).
 */
export type PlatformAuditAction =
  'JOB_RETRIED' | 'MFA_ENROLLMENT_STARTED' | 'MFA_ENABLED' | 'PASSWORD_CHANGE';

export type PlatformAuditResourceType = 'JOB' | 'USER';

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
export interface PlatformAuditEventDraft {
  actor: PlatformAuditActor;
  action: Exclude<PlatformAuditAction, 'JOB_RETRIED'>;
  resourceType: 'USER';
  resourceId: string;
}

/** El superadmin actúa sobre su propia cuenta (MFA, contraseña). */
export function ownPlatformAccountEvent(
  actor: PlatformAuditActor,
  action: PlatformAuditEventDraft['action'],
): PlatformAuditEventDraft {
  return { actor, action, resourceType: 'USER', resourceId: actor.userId };
}
