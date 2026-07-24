import { Controller, Get, UseInterceptors } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { GetTenantBrandingUseCase } from '../application/use-cases/get-tenant-branding.use-case';
import { BrandingDto } from './dto/branding.dto';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';

// PUBLIC endpoint — no JwtAuthGuard/RolesGuard. The web app's login/marketing
// shell needs the tenant's white-label branding before any user is
// authenticated. Tenant identity comes solely from the resolved request host
// (see PublicTenantContextInterceptor + TenantHostMiddleware); there is no
// JWT to cross-check.
@ApiTags('public')
@UseInterceptors(PublicTenantContextInterceptor)
@Controller('public/tenant')
export class PublicBrandingController {
  constructor(private readonly getTenantBranding: GetTenantBrandingUseCase) {}

  @Get('branding')
  @ApiOkResponse({ type: BrandingDto })
  branding(): Promise<BrandingDto> {
    return this.getTenantBranding.execute();
  }
}
