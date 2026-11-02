export const PLATFORM_MFA_REPOSITORY = Symbol('PLATFORM_MFA_REPOSITORY');

/** Estado del MFA del superadmin (DX-021-bis: el alta es la del login). */
export interface PlatformMfaState {
  enabledAt: Date | null;
  /** Códigos de recuperación sin usar. */
  recoveryCodesRemaining: number;
}

export interface PlatformMfaRepository {
  find(userId: string): Promise<PlatformMfaState | null>;
}
