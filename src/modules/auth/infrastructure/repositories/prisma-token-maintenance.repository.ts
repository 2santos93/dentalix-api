import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type {
  PurgedTokens,
  TokenMaintenanceRepository,
} from '../../domain/ports/token-maintenance-repository.port';

/**
 * Borrado duro legítimo (housekeeping con TTL, como la antigua limpieza lazy):
 * tablas globales sin RLS, fuera de `runWithTenant`. Usa los índices
 * `expiresAt` de cada tabla.
 */
@Injectable()
export class PrismaTokenMaintenanceRepository implements TokenMaintenanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async purgeExpired(
    now: Date,
    userTokenGraceMs: number,
  ): Promise<PurgedTokens> {
    const graceLimit = new Date(now.getTime() - userTokenGraceMs);
    // eslint-disable-next-line no-restricted-syntax
    const revoked = await this.prisma.revokedToken.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    // eslint-disable-next-line no-restricted-syntax
    const pending = await this.prisma.pendingRegistration.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    // eslint-disable-next-line no-restricted-syntax
    const userTokens = await this.prisma.userToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: graceLimit } },
          { usedAt: { lt: graceLimit } },
          { invalidatedAt: { lt: graceLimit } },
        ],
      },
    });
    return {
      revokedTokens: revoked.count,
      userTokens: userTokens.count,
      pendingRegistrations: pending.count,
    };
  }
}
