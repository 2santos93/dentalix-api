export const BREAK_GLASS_REPOSITORY = Symbol('BREAK_GLASS_REPOSITORY');

/** MFA del superadmin tal como se guarda (secreto cifrado). */
export interface UserMfaRecord {
  /** `null` = sin MFA confirmado (plan de transición: no hay break-glass). */
  secretEnc: string | null;
  lastUsedStep: number | null;
}

export interface BreakGlassAccessInput {
  tenantId: string;
  userId: string;
  reason: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface BreakGlassRepository {
  findMfa(userId: string): Promise<UserMfaRecord | null>;
  /**
   * Marca `step` como usado si es POSTERIOR al último aceptado, en una sola
   * sentencia: de dos logins concurrentes con el mismo código solo uno gana.
   * `false` si ya estaba usado (o el MFA dejó de estar activo).
   */
  consumeTotpStep(userId: string, step: number): Promise<boolean>;
  /** Inserta la fila de `platform_access_audit` (bajo la RLS del tenant). */
  recordAccess(input: BreakGlassAccessInput): Promise<void>;
}
