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
   * Con la hora de la BD, no la del worker (revisión H7):
   * - `revoked_tokens` vencidos hace más de 5 min: el refresh token ya es
   *   inválido por su TTL; el margen cubre un reloj de la API atrasado.
   * - `pending_registrations` caducadas: guardan un email y un hash de
   *   contraseña, no se conservan.
   * - `user_tokens` caducados, usados o invalidados hace más de
   *   `userTokenGraceMs`: durante ese margen el enlace aún responde
   *   EXPIRED/USED (y no INVALID) a quien lo abre tarde.
   */
  purgeExpired(userTokenGraceMs: number): Promise<PurgedTokens>;
}
