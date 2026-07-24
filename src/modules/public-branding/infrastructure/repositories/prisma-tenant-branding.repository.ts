import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantBrandingRepository } from '../../domain/ports/tenant-branding-repository.port';
import { TenantBranding } from '../../domain/entities/tenant-branding.entity';

@Injectable()
export class PrismaTenantBrandingRepository implements TenantBrandingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(tenantId: string): Promise<TenantBranding | null> {
    // `tenants` has no tenant_isolation RLS policy (see the RLS migrations —
    // only per-tenant domain tables like clinic_memberships/patients do), so
    // this reads directly through the app's regular Prisma connection,
    // explicitly scoped to the host-resolved tenantId — same pattern as
    // TenantResolverService.resolve(). No runWithTenant, no DIRECT_URL.
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { name: true, primaryColor: true, logoUrl: true },
    });

    if (!tenant) return null;

    return this.mapToEntity(tenant);
  }

  private mapToEntity(tenant: {
    name: string;
    primaryColor: string;
    logoUrl: string | null;
  }): TenantBranding {
    return {
      name: tenant.name,
      primaryColor: tenant.primaryColor,
      logoUrl: tenant.logoUrl,
    };
  }
}
