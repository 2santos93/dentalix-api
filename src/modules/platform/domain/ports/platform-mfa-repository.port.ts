import type { PlatformAuditActor } from '../../../audit/domain/platform-audit-event';

export const PLATFORM_MFA_REPOSITORY = Symbol('PLATFORM_MFA_REPOSITORY');

/** MFA del superadmin tal como se guarda (secretos cifrados). */
export interface PlatformMfaState {
  email: string;
  enabledAt: Date | null;
  pendingSecretEnc: string | null;
}

export interface PlatformMfaRepository {
  find(userId: string): Promise<PlatformMfaState | null>;
  /**
   * Guarda (o reemplaza) el secreto PENDIENTE de confirmar. `false` si el MFA
   * ya está activo: un alta nueva no pisa el secreto vigente.
   *
   * DX-359: si guarda, escribe MFA_ENROLLMENT_STARTED en
   * `platform_audit_events` en la MISMA transacción.
   */
  savePending(
    userId: string,
    pendingSecretEnc: string,
    actor: PlatformAuditActor,
  ): Promise<boolean>;
  /**
   * Activa el MFA con el secreto pendiente `pendingSecretEnc` (el que se
   * verificó) y marca `step` como usado. Atómico: `false` si entretanto
   * cambió el pendiente o el MFA ya se activó.
   *
   * DX-359: si activa, escribe MFA_ENABLED en la misma transacción.
   */
  confirm(
    userId: string,
    pendingSecretEnc: string,
    step: number,
    actor: PlatformAuditActor,
  ): Promise<Date | null>;
}
