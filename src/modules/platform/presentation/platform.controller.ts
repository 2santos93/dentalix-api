import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { PlatformTenantDto } from './dto/platform-tenant.dto';
import { ListTenantsUseCase } from '../application/use-cases/list-tenants.use-case';
import type { PlatformTenant } from '../domain/ports/platform-repository.port';

/**
 * Rutas de PLATAFORMA (apex, sin clínica). A diferencia del resto de la API,
 * NO llevan `TenantContextInterceptor`: ese interceptor exige que el host
 * resuelva a un tenant y aquí, por definición, no hay ninguno.
 */
@ApiTags('platform')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('platform')
export class PlatformController {
  constructor(private readonly listTenants: ListTenantsUseCase) {}

  @Get('tenants')
  @ApiOkResponse({ type: [PlatformTenantDto] })
  tenants(): Promise<PlatformTenant[]> {
    return this.listTenants.execute();
  }
}
