import { Module } from '@nestjs/common';
import { PublicBrandingController } from './presentation/public-branding.controller';
import { GetTenantBrandingUseCase } from './application/use-cases/get-tenant-branding.use-case';
import { TENANT_BRANDING_REPOSITORY } from './domain/ports/tenant-branding-repository.port';
import { PrismaTenantBrandingRepository } from './infrastructure/repositories/prisma-tenant-branding.repository';
import { PublicTenantContextInterceptor } from '../../shared/tenancy/public-tenant-context.interceptor';

@Module({
  controllers: [PublicBrandingController],
  providers: [
    GetTenantBrandingUseCase,
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
