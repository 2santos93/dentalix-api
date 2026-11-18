export const TOKEN_MAINTENANCE_REPOSITORY = Symbol(
  'TOKEN_MAINTENANCE_REPOSITORY',
);

export interface PurgedTokens {
  revokedTokens: number;
  /** Familias de refresh cuyo último token ya venció. */
  refreshSessions: number;
  userTokens: number;
  pendingRegistrations: number;
  /** DX-048: contadores de fallos de login ya olvidados. */
  loginThrottles: number;
  /** DX-137: huellas de dispositivo sin usar en 90 días. */
  loginDevices: number;
}

/**
 * Purga de tokens que ya no sirven (DX-085), en las tablas GLOBALES de auth
 * (sin tenant ni RLS): `revoked_tokens`, `user_tokens`,
 * `pending_registrations` y `login_throttles`.
 */
export interface TokenMaintenanceRepository {
  /**
   * Con la hora de la BD, no la del worker (revisión H7):
   * - `revoked_tokens` vencidos hace más de 5 min: el refresh token ya es
   *   inválido por su TTL; el margen cubre un reloj de la API atrasado.
   *   Igual `refresh_sessions` (su `expiresAt` es el del último token).
   * - DX-137: `user_login_devices` sin verse en 90 días (huella del aviso
   *   de inicio de sesión nuevo: un dato personal mínimo, no se conserva).
   *   La IP truncada y el navegador de `refresh_sessions` se van con su
   *   familia, que vive como mucho el TTL del refresh (≤ 90 días).
   * - `pending_registrations` caducadas: guardan un email y un hash de
   *   contraseña, no se conservan.
   * - `user_tokens` caducados, usados o invalidados hace más de
   *   `userTokenGraceMs`: durante ese margen el enlace aún responde
   *   EXPIRED/USED (y no INVALID) a quien lo abre tarde.
   * - `login_throttles` (DX-048) sin fallos desde hace `loginThrottleStaleMs`
   *   y sin espera vigente: el contador ya se habría olvidado.
   */
  purgeExpired(
    userTokenGraceMs: number,
    loginThrottleStaleMs: number,
  ): Promise<PurgedTokens>;
}
