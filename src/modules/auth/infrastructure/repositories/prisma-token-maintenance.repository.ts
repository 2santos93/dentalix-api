import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type {
  PurgedTokens,
  TokenMaintenanceRepository,
} from '../../domain/ports/token-maintenance-repository.port';

/**
 * Borrado duro legítimo (housekeeping con TTL, como la antigua limpieza lazy):
 * tablas globales sin RLS, fuera de `runWithTenant`. Usa los índices
 * `expiresAt` de cada tabla y la hora de la BD.
 */
@Injectable()
export class PrismaTokenMaintenanceRepository implements TokenMaintenanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async purgeExpired(userTokenGraceMs: number): Promise<PurgedTokens> {
    const now = Prisma.sql`timezone('utc', now())`;
    const grace = Prisma.sql`make_interval(secs => ${userTokenGraceMs / 1000}::double precision)`;
    const revokedTokens = await this.prisma.$executeRaw`
      DELETE FROM "revoked_tokens"
       WHERE "expiresAt" < ${now} - interval '5 minutes'`;
    const pendingRegistrations = await this.prisma.$executeRaw`
      DELETE FROM "pending_registrations" WHERE "expiresAt" < ${now}`;
    const userTokens = await this.prisma.$executeRaw`
      DELETE FROM "user_tokens"
       WHERE "expiresAt" < ${now} - ${grace}
          OR "usedAt" < ${now} - ${grace}
          OR "invalidatedAt" < ${now} - ${grace}`;
    return { revokedTokens, userTokens, pendingRegistrations };
  }
}
