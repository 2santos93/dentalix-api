import { Module } from '@nestjs/common';
import { PublicBrandingController } from './presentation/public-branding.controller';
import { PublicBrandingByHostController } from './presentation/public-branding-by-host.controller';
import { GetTenantBrandingUseCase } from './application/use-cases/get-tenant-branding.use-case';
import { GetTenantBrandingByHostUseCase } from './application/use-cases/get-tenant-branding-by-host.use-case';
import { TENANT_BRANDING_REPOSITORY } from './domain/ports/tenant-branding-repository.port';
import { PrismaTenantBrandingRepository } from './infrastructure/repositories/prisma-tenant-branding.repository';
import { PublicTenantContextInterceptor } from '../../shared/tenancy/public-tenant-context.interceptor';

@Module({
  controllers: [PublicBrandingController, PublicBrandingByHostController],
  providers: [
    GetTenantBrandingUseCase,
    // DX-517-ter: usa el TenantResolverService del módulo @Global de tenancy.
    GetTenantBrandingByHostUseCase,
    // PublicTenantContextInterceptor only depends on the @Global
    // TenantContextService; listing it here makes it resolvable for
    // @UseInterceptors on PublicBrandingController (same convention as
    // TenantContextInterceptor in StaffModule).
    PublicTenantContextInterceptor,
    {
      provide: TENANT_BRANDING_REPOSITORY,
      useClass: PrismaTenantBrandingRepository,
    },
  ],
})
export class PublicBrandingModule {}
