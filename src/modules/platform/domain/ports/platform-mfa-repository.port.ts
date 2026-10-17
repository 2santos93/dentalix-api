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
   */
  savePending(userId: string, pendingSecretEnc: string): Promise<boolean>;
  /**
   * Activa el MFA con el secreto pendiente `pendingSecretEnc` (el que se
   * verificó) y marca `step` como usado. Atómico: `false` si entretanto
   * cambió el pendiente o el MFA ya se activó.
   */
  confirm(
    userId: string,
    pendingSecretEnc: string,
    step: number,
  ): Promise<Date | null>;
}
