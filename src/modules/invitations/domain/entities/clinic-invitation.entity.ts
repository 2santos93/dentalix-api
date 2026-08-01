import { ClinicRole } from '@prisma/client';

export type InvitationStatus = 'VALID' | 'EXPIRED' | 'USED' | 'REVOKED';

/**
 * Invitación de personal, tal como cruza el límite del port. NO expone
 * `tokenHash` — el hash es un detalle de persistencia/verificación que el
 * repositorio Prisma maneja internamente (ver
 * `prisma-invitation.repository.ts`).
 */
export interface ClinicInvitation {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: ClinicRole;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  invitedById: string | null;
  createdAt: Date;
}
