import type { AuditEventDraft } from '../../../audit/domain/audit-event';

export const USER_MFA_REPOSITORY = Symbol('USER_MFA_REPOSITORY');

/** DX-021: MFA de un usuario tal como se guarda (secretos cifrados). */
export interface UserMfaState {
  email: string;
  passwordHash: string;
  isPlatformAdmin: boolean;
  tokenVersion: number;
  secretEnc: string | null;
  pendingSecretEnc: string | null;
  enabledAt: Date | null;
  lastUsedStep: number | null;
  /** Códigos de recuperación sin usar. */
  recoveryCodesRemaining: number;
}

export interface UserMfaRepository {
  find(userId: string): Promise<UserMfaState | null>;
  /**
   * Guarda (o reemplaza) el secreto PENDIENTE. `false` si el MFA ya está
   * activo: un alta nueva nunca pisa el secreto vigente.
   */
  savePending(userId: string, pendingSecretEnc: string): Promise<boolean>;
  /**
   * Activa el MFA con `pendingSecretEnc` (el que se verificó), marca `step`
   * como usado, reemplaza los códigos de recuperación por `codeHashes`,
   * incrementa `tokenVersion` (cierra las demás sesiones) y escribe `audit`,
   * todo en UNA transacción bajo el tenant del evento. `null` si entretanto
   * cambió el pendiente o el MFA ya se activó.
   */
  enable(
    userId: string,
    pendingSecretEnc: string,
    step: number,
    codeHashes: string[],
    audit: AuditEventDraft,
  ): Promise<{ enabledAt: Date; tokenVersion: number } | null>;
  /**
   * Desactiva (borra secretos, paso usado y códigos), incrementa
   * `tokenVersion` y escribe `audit`. Devuelve la versión nueva o `null` si
   * no estaba activo.
   */
  disable(userId: string, audit: AuditEventDraft): Promise<number | null>;
  /** Reemplaza los códigos (los anteriores dejan de valer) y escribe `audit`. */
  replaceRecoveryCodes(
    userId: string,
    codeHashes: string[],
    audit: AuditEventDraft,
  ): Promise<boolean>;
  /**
   * Marca usado el código con esa huella si aún no lo estaba, en UNA
   * sentencia: dos peticiones con el mismo código, solo una gana.
   */
  consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean>;
  /** `requireAdminMfa` de la clínica; `null` si no existe. */
  findClinicPolicy(tenantId: string): Promise<boolean | null>;
  setClinicPolicy(tenantId: string, requireAdminMfa: boolean): Promise<void>;
}
