import { ClinicRole, Prisma } from '@prisma/client';
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
   *
   * DX-149-ter: la transacción es de la clínica del host (`tenantId`, bajo su
   * RLS) y `enqueue` encola en ella el email del enlace: token y email
   * confirman o se deshacen juntos. Lleva un `lock_timeout` corto (endpoint
   * público: nadie retiene una conexión del pool esperando un candado); si se
   * agota, lanza PasswordResetThrottledError('LOCK_TIMEOUT') sin cambiar
   * nada. Lo que lance `enqueue` deshace también el token.
   *
   * DX-149-quater: con la fila del usuario ya bloqueada, cuenta los enlaces
   * que se le emitieron en las 24 h anteriores a `now` (en `user_tokens`,
   * global: suma TODAS sus clínicas). Si ya son `userDailyLimit`, lanza
   * PasswordResetThrottledError('USER_QUOTA') sin cambiar nada.
   */
  issue(input: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
    userDailyLimit: number;
    enqueue?: (tx: Prisma.TransactionClient) => Promise<void>;
  }): Promise<void>;

  /**
   * DX-149-quater: enlaces de restablecimiento emitidos a `userId` después de
   * `since`, en todas sus clínicas. Lectura sin candado (aviso temprano): el
   * tope que manda lo cuenta `issue` bajo el bloqueo de la fila.
   */
  countIssuedSince(userId: string, since: Date): Promise<number>;

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
