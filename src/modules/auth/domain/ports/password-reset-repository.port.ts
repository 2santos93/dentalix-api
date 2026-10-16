import { ClinicRole } from '@prisma/client';
import type { StoredResetToken } from '../../application/password-reset-token';

export const PASSWORD_RESET_REPOSITORY = Symbol('PASSWORD_RESET_REPOSITORY');

/** Miembro ACTIVO de una clínica, para enviarle el enlace. */
export interface ResetRecipient {
  userId: string;
  email: string;
  fullName: string;
}

export interface ResetTokenRecord extends StoredResetToken {
  id: string;
  userId: string;
}

export interface PasswordResetRepository {
  /**
   * Usuario vivo con membresía ACTIVA en `tenantId` cuyo email es `email`
   * (ya normalizado), o `null`. La membresía se lee bajo la RLS del tenant.
   */
  findActiveMember(
    tenantId: string,
    email: string,
  ): Promise<ResetRecipient | null>;

  /** Rol de la membresía ACTIVA de `userId` en `tenantId`, o `null`. */
  activeMembershipRole(
    tenantId: string,
    userId: string,
  ): Promise<ClinicRole | null>;

  /**
   * Guarda un token nuevo (solo su hash) e invalida en la MISMA transacción
   * los anteriores aún vivos del usuario: solo vale el último enlace.
   */
  issue(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<void>;

  findByHash(tokenHash: string): Promise<ResetTokenRecord | null>;

  /**
   * Consume el token y cambia la contraseña en UNA transacción: marca el token
   * como usado solo si sigue vivo (check-and-set, gana una sola petición),
   * invalida cualquier otro vivo del usuario, guarda el hash nuevo e
   * incrementa `tokenVersion` (cierra todas las sesiones, SEC-002). Devuelve
   * `false` sin cambiar nada si el token ya no estaba vivo.
   */
  consumeAndSetPassword(input: {
    tokenId: string;
    userId: string;
    passwordHash: string;
    now: Date;
  }): Promise<boolean>;
}
