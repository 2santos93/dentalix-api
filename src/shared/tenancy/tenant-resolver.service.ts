import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { parseHost } from './host-parser';

@Injectable()
export class TenantResolverService {
  private readonly baseDomains: string[];

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.baseDomains = (
      config.get<string>('TENANT_BASE_DOMAINS') ?? 'localhost'
    )
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }

  async resolve(rawHost: string | undefined): Promise<string | null> {
    const parsed = parseHost(rawHost, this.baseDomains);
    if (!parsed) return null;

    if (parsed.kind === 'subdomain') {
      const tenant = await this.prisma.tenant.findFirst({
        where: { subdomain: parsed.subdomain, deletedAt: null },
        select: { id: true },
      });
      return tenant?.id ?? null;
    }

    const domain = await this.prisma.tenantDomain.findFirst({
      where: { host: parsed.host, status: 'VERIFIED', deletedAt: null },
      select: { tenantId: true },
    });
    return domain?.tenantId ?? null;
  }
}
