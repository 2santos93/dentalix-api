import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { TenantDomainRepository } from '../../domain/ports/tenant-domain-repository.port';
import { TenantDomainRecord } from '../../domain/entities/tenant-domain.entity';

const SELECT = {
  id: true,
  host: true,
  status: true,
  verifyToken: true,
  verifiedAt: true,
  createdAt: true,
} as const;

@Injectable()
export class PrismaTenantDomainRepository implements TenantDomainRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // tenant_domains has NO RLS (it is queried before a tenant is known, for
  // routing). Every management query MUST be scoped by the context tenant.
  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async create(input: {
    host: string;
    verifyToken: string;
  }): Promise<TenantDomainRecord> {
    return this.prisma.tenantDomain.create({
      data: {
        tenantId: this.tenantId(),
        host: input.host,
        verifyToken: input.verifyToken,
      },
      select: SELECT,
    });
  }

  listByTenant(): Promise<TenantDomainRecord[]> {
    return this.prisma.tenantDomain.findMany({
      where: { tenantId: this.tenantId(), deletedAt: null },
      select: SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  findByHostForTenant(host: string): Promise<TenantDomainRecord | null> {
    return this.prisma.tenantDomain.findFirst({
      where: { tenantId: this.tenantId(), host, deletedAt: null },
      select: SELECT,
    });
  }

  findById(id: string): Promise<TenantDomainRecord | null> {
    return this.prisma.tenantDomain.findFirst({
      where: { id, tenantId: this.tenantId(), deletedAt: null },
      select: SELECT,
    });
  }

  async markVerified(id: string): Promise<void> {
    await this.prisma.tenantDomain.updateMany({
      where: { id, tenantId: this.tenantId(), deletedAt: null },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    });
  }
}
