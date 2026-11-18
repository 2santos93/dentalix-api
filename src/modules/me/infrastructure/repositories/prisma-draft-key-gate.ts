import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type {
  DraftKeyGate,
  DraftKeySessionQuery,
} from '../../domain/ports/draft-key-gate.port';

/**
 * DX-574: `users`, `tenants` y `refresh_sessions` son globales (Prisma
 * directo); la membresía tiene RLS y se lee con la clínica del token.
 */
@Injectable()
export class PrismaDraftKeyGate implements DraftKeyGate {
  constructor(private readonly prisma: PrismaService) {}

  async liveTokenVersion(query: DraftKeySessionQuery): Promise<number | null> {
    const { userId, tenantId, sessionId } = query;
    const [user, tenant, session] = await Promise.all([
      this.prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { tokenVersion: true },
      }),
      this.prisma.tenant.findFirst({
        where: { id: tenantId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.refreshSession.findFirst({
        where: {
          id: sessionId,
          userId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { id: true },
      }),
    ]);
    if (!user || !tenant || !session) return null;
    const membership = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.clinicMembership.findFirst({
        where: { tenantId, userId, deletedAt: null },
        select: { id: true },
      }),
    );
    return membership ? user.tokenVersion : null;
  }
}
