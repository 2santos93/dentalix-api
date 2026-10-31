/**
 * Rotación de refresh tokens por FAMILIA (una por inicio de sesión, claim
 * `sid`), con detección de reuso y una gracia corta para el token anterior.
 *
 * El problema que resuelve: el refresh es de un solo uso y la API lo rota en
 * cada /auth/refresh. Si la respuesta se pierde DESPUÉS de que la API rotara
 * (el navegador recarga la página con el refresh en vuelo y aborta la
 * petición; o se corta la red), el cliente se queda con la cookie anterior,
 * que ya no vale: el siguiente refresh daba 401 y la sesión se cerraba. Ni un
 * single-flight ni un lock entre pestañas lo evitan: el lock muere con la
 * página y el cliente no puede saber si la API llegó a rotar.
 *
 * Reglas (OAuth 2.0 Security BCP, §4.14.2 «refresh token rotation»):
 * - Token VIGENTE (`currentJti`) → se rota: el vigente pasa a anterior.
 * - Token ANTERIOR dentro de la gracia (desde la rotación, que no se alarga) →
 *   se le entrega otra copia del VIGENTE (mismo `jti` y `exp`). No nace una
 *   segunda cadena: sigue habiendo un único token vivo, y quien lo use
 *   primero hace que la otra copia pase a ser «anterior».
 * - Cualquier otro token de la familia (anterior fuera de la gracia, o más
 *   viejo) → REUSO: alguien guardó un token que el dueño ya había gastado.
 *   Se revoca la familia ENTERA (ladrón y víctima vuelven a /login), en vez
 *   de solo rechazar ese token y dejar viva la cadena del que rotó primero.
 * - Familia revocada (logout o reuso) → 401.
 */
export type RefreshRotationDecision = 'rotate' | 'grace' | 'reused' | 'revoked';

export interface RefreshSessionState {
  currentJti: string;
  previousJti: string | null;
  rotatedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** Gracia por defecto para el token anterior (JWT_REFRESH_REUSE_GRACE_SECONDS). */
export const DEFAULT_REFRESH_REUSE_GRACE_SECONDS = 30;
/** Tope: más gracia es más ventana para un token robado sin detectar. */
export const MAX_REFRESH_REUSE_GRACE_SECONDS = 60;
export const REFRESH_REUSE_GRACE_ENV = 'JWT_REFRESH_REUSE_GRACE_SECONDS';
export const REFRESH_REUSE_GRACE_MS = Symbol('REFRESH_REUSE_GRACE_MS');

export function decideRefreshRotation(
  state: RefreshSessionState,
  presentedJti: string,
  now: Date,
  graceMs: number,
): RefreshRotationDecision {
  if (state.revokedAt) return 'revoked';
  if (presentedJti === state.currentJti) return 'rotate';
  if (
    presentedJti === state.previousJti &&
    state.rotatedAt !== null &&
    now.getTime() - state.rotatedAt.getTime() <= graceMs
  ) {
    return 'grace';
  }
  return 'reused';
}

/** Problemas de configuración de la gracia (vacío = válida o ausente). */
export function refreshReuseGraceProblems(raw: string | undefined): string[] {
  if (raw == null || raw.trim() === '') return [];
  const value = raw.trim();
  if (
    !/^\d{1,3}$/.test(value) ||
    Number(value) > MAX_REFRESH_REUSE_GRACE_SECONDS
  ) {
    return [
      `${REFRESH_REUSE_GRACE_ENV} debe ser un entero entre 0 y ${MAX_REFRESH_REUSE_GRACE_SECONDS} (segundos; 0 = sin gracia).`,
    ];
  }
  return [];
}

/** Gracia en ms (ya validada por `validateEnv`). */
export function loadRefreshReuseGraceMs(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') {
    return DEFAULT_REFRESH_REUSE_GRACE_SECONDS * 1000;
  }
  return Number(raw.trim()) * 1000;
}
