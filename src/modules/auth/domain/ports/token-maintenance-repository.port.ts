export const TOKEN_MAINTENANCE_REPOSITORY = Symbol(
  'TOKEN_MAINTENANCE_REPOSITORY',
);

export interface PurgedTokens {
  revokedTokens: number;
  userTokens: number;
  pendingRegistrations: number;
}

/**
 * Purga de tokens que ya no sirven (DX-085), en las tablas GLOBALES de auth
 * (sin tenant ni RLS): `revoked_tokens`, `user_tokens` y
 * `pending_registrations`.
 */
export interface TokenMaintenanceRepository {
  /**
   * - `revoked_tokens` vencidos (`expiresAt` < now): el refresh token ya es
   *   inválido por su TTL; la entrada de la denylist no aporta nada.
   * - `pending_registrations` caducadas: guardan un email y un hash de
   *   contraseña, no se conservan.
   * - `user_tokens` caducados, usados o invalidados hace más de
   *   `userTokenGraceMs`: durante ese margen el enlace aún responde
   *   EXPIRED/USED (y no INVALID) a quien lo abre tarde.
   */
  purgeExpired(now: Date, userTokenGraceMs: number): Promise<PurgedTokens>;
}
