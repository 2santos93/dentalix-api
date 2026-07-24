import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { TenantBranding } from '../../domain/entities/tenant-branding.entity';
import { TENANT_BRANDING_REPOSITORY } from '../../domain/ports/tenant-branding-repository.port';
import type { TenantBrandingRepository } from '../../domain/ports/tenant-branding-repository.port';

@Injectable()
export class GetTenantBrandingUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(TENANT_BRANDING_REPOSITORY)
    private readonly repo: TenantBrandingRepository,
  ) {}

  async execute(): Promise<TenantBranding> {
    // The host is the only source of tenant identity here (no JWT on a
    // public route) — see PublicTenantContextInterceptor. No/unknown host
    // means no tenant was ever put into context.
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new NotFoundException('Tenant not found');
    }

    const branding = await this.repo.findById(tenantId);
    if (!branding) {
      throw new NotFoundException('Tenant not found');
    }

    return branding;
  }
}
