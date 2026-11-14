import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type { OwnAccountAuditEventDraft } from '../../../audit/domain/platform-audit-event';
import type { ClinicRole } from '@prisma/client';
import type { MfaAuditDraft } from '../user-mfa-audit';
import type { ClinicMfaPolicy } from '../user-mfa';

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

/** DX-021-bis: un dispositivo de confianza vigente, para «Mi perfil». */
export interface TrustedDevice {
  id: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
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
   * todo en UNA transacción (bajo el tenant del evento; un evento de
   * plataforma no tiene). `null` si entretanto cambió el pendiente o el MFA ya
   * se activó.
   */
  enable(
    userId: string,
    pendingSecretEnc: string,
    step: number,
    codeHashes: string[],
    audit: MfaAuditDraft,
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
    audit: MfaAuditDraft,
  ): Promise<boolean>;
  /**
   * Marca usado el código con esa huella si aún no lo estaba, en UNA
   * sentencia: dos peticiones con el mismo código, solo una gana.
   */
  consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean>;
  /** La política de la clínica; `null` si no existe. */
  findClinicPolicy(tenantId: string): Promise<ClinicMfaPolicy | null>;
  /**
   * DX-021-bis: guarda la política, cierra las sesiones (`tokenVersion` + 1) de
   * los miembros activos que `roles` obliga y aún no tienen MFA, y escribe el
   * evento que `audit` construye con cuántos fueron, todo en una transacción.
   * `roles` vacío: nadie queda obligado de nuevo. Devuelve cuántos.
   */
  setClinicPolicy(
    tenantId: string,
    policy: ClinicMfaPolicy,
    roles: ClinicRole[],
    audit: AuditEventDraft,
  ): Promise<number>;
  /** Evento de plataforma suelto (sin cambio de datos que lo acompañe). */
  recordPlatformEvent(draft: OwnAccountAuditEventDraft): Promise<void>;
  /** Rol de un miembro ACTIVO de la clínica, bajo su RLS; `null` si no lo es. */
  findActiveMemberRole(
    tenantId: string,
    userId: string,
  ): Promise<ClinicRole | null>;
  /** ¿Tiene membresía activa en otra clínica? (ni cuál ni cuántas). */
  hasOtherActiveMemberships(userId: string, tenantId: string): Promise<boolean>;
  /** Guarda un dispositivo y borra los ya muertos del usuario. */
  addTrustedDevice(input: {
    userId: string;
    tokenHash: string;
    tokenVersion: number;
    label: string;
    expiresAt: Date;
  }): Promise<void>;
  /**
   * ¿Esa huella es un dispositivo vigente del usuario (sin revocar, sin
   * caducar y con su `tokenVersion` actual)? Si lo es, anota el uso.
   */
  touchTrustedDevice(
    userId: string,
    tokenHash: string,
    tokenVersion: number,
  ): Promise<boolean>;
  listTrustedDevices(
    userId: string,
    tokenVersion: number,
  ): Promise<TrustedDevice[]>;
  /** Revoca uno (`id`) o todos (`null`). Devuelve cuántos. */
  revokeTrustedDevices(userId: string, id: string | null): Promise<number>;
}
