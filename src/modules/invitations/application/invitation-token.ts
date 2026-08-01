import { randomBytes, createHash } from 'node:crypto';
import { InvitationStatus } from '../domain/entities/clinic-invitation.entity';

/**
 * Token de invitación en texto plano, entregado únicamente en el enlace que
 * recibe la persona invitada. NUNCA se persiste — solo su hash (ver
 * `hashInvitationToken`). 32 bytes (vs. los 16 de
 * `register-domain.use-case.ts`) porque esto es una credencial de acceso, no
 * un token de verificación de dominio.
 */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('hex');
}

/** Hash estable de un token, para buscar/almacenar sin guardar el texto plano. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Enmascara un correo para mostrarlo en listados sin exponerlo completo:
 * conserva hasta 2 caracteres locales + `***` + el dominio tal cual.
 */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  const visible = local.slice(0, 2);
  return `${visible}***@${domain}`;
}

/**
 * Clasifica el estado de una invitación por precedencia: revocada > usada >
 * expirada > válida.
 */
export function invitationStatus(
  inv: { expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null },
  now: Date,
): InvitationStatus {
  if (inv.revokedAt) {
    return 'REVOKED';
  }
  if (inv.acceptedAt) {
    return 'USED';
  }
  if (inv.expiresAt <= now) {
    return 'EXPIRED';
  }
  return 'VALID';
}
