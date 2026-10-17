import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import type { SupportAccessRepository } from '../domain/ports/support-access-repository.port';
import type {
  SupportAccess,
  SupportAccessCursor,
} from '../domain/support-access';

@Injectable()
export class PrismaSupportAccessRepository implements SupportAccessRepository {
  constructor(private readonly prisma: PrismaService) {}

  // runWithTenant: la RLS FORZADA de platform_access_audit es la que acota a
  // la clínica del host; el filtro explícito por tenant no hace falta (y el
  // índice (tenantId, createdAt DESC, id DESC) sirve igual con el predicado
  // de la política).
  async list(
    take: number,
    after: SupportAccessCursor | null,
  ): Promise<SupportAccess[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.platformAccessAudit.findMany({
        where: after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }
          : undefined,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
        select: {
          id: true,
          reason: true,
          ip: true,
          userAgent: true,
          createdAt: true,
          expiresAt: true,
          user: { select: { fullName: true, email: true } },
        },
      }),
    );
    return rows.map(({ user, ...row }) => ({
      ...row,
      userFullName: user.fullName,
      userEmail: user.email,
    }));
  }
}
