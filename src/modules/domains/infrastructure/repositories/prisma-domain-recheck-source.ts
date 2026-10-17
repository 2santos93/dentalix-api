import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type {
  DomainRecheckSource,
  VerifiedDomainRef,
} from '../../domain/ports/domain-recheck-source.port';

/** Ver DomainRecheckSource: lectura de plataforma, solo ids. */
@Injectable()
export class PrismaDomainRecheckSource implements DomainRecheckSource {
  constructor(private readonly prisma: PrismaService) {}

  listVerified(
    afterHost: string | null,
    limit: number,
  ): Promise<VerifiedDomainRef[]> {
    return this.prisma.tenantDomain.findMany({
      where: {
        status: 'VERIFIED',
        deletedAt: null,
        ...(afterHost ? { host: { gt: afterHost } } : {}),
      },
      select: { id: true, tenantId: true, host: true },
      orderBy: { host: 'asc' },
      take: limit,
    });
  }
}
