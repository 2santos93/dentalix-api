import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type { OwnAccountAuditEvent } from '../own-account-audit';

export const USER_PROFILE_REPOSITORY = Symbol('USER_PROFILE_REPOSITORY');

export interface UserRecord {
  id: string;
  email: string;
  fullName: string;
  /** Clave del avatar (`avatars/<id>.<ext>`, DX-084), no una URL. */
  avatarKey: string | null;
  emailVerifiedAt: Date | null;
}

export interface UserProfileRepository {
  findUserById(userId: string): Promise<UserRecord | null>;
  findClinicName(tenantId: string): Promise<string | null>;
  getPasswordHash(userId: string): Promise<string | null>;
  /**
   * DX-359: guarda el nombre y, si cambió, escribe `audit` en la MISMA
   * transacción (en la clínica del evento).
   */
  updateName(
    userId: string,
    fullName: string,
    audit: AuditEventDraft,
  ): Promise<void>;
  /**
   * Guarda el hash nuevo e incrementa `tokenVersion` en la MISMA sentencia,
   * lo que invalida todos los refresh tokens previos del usuario. Devuelve la
   * versión nueva. DX-359: con el evento `audit` en la misma transacción.
   */
  updatePasswordAndRevokeSessions(
    userId: string,
    passwordHash: string,
    audit: OwnAccountAuditEvent,
  ): Promise<number>;
  updateAvatarKey(userId: string, avatarKey: string | null): Promise<void>;
}
