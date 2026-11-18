export const DRAFT_KEY_GATE = Symbol('DRAFT_KEY_GATE');

/** DX-574: lo que tiene que estar vivo para entregar la clave de borradores. */
export interface DraftKeySessionQuery {
  userId: string;
  tenantId: string;
  /** Familia de refresh del access token (`sid`). */
  sessionId: string;
}

export interface DraftKeyGate {
  /**
   * La `users.tokenVersion` vigente si el usuario existe, la clínica está
   * activa, tiene membresía activa en ella y su sesión (`sid`) no está
   * revocada ni caducada; `null` en cualquier otro caso.
   */
  liveTokenVersion(query: DraftKeySessionQuery): Promise<number | null>;
}
