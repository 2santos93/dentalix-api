import { Controller, Get, Query, UseInterceptors } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { GetTenantBrandingByHostUseCase } from '../application/use-cases/get-tenant-branding-by-host.use-case';
import { BrandingDto } from './dto/branding.dto';
import { NoStoreHeadersInterceptor } from '../../../shared/http/no-store-headers.interceptor';

// DX-517-ter. PÚBLICA y SIN clínica en contexto: ni JwtAuthGuard/RolesGuard ni
// PublicTenantContextInterceptor (va en su propio controlador para no heredar
// el de `PublicBrandingController`). La clínica sale SOLO del parámetro
// `host`; las cabeceras de la petición (Host, X-Forwarded-Host, X-Tenant-Host,
// X-Tenant) no cuentan. Límite: el global del throttler (por IP y ruta).
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor)
@Controller('public/tenant')
export class PublicBrandingByHostController {
  constructor(private readonly getByHost: GetTenantBrandingByHostUseCase) {}

  @Get('branding/by-host')
  @ApiOperation({
    summary: 'Marca pública de la clínica de un host',
    description:
      'La pide el servidor web con el host de la página para pintar la marca en el primer HTML. Mismos campos que GET /public/tenant/branding. Un host desconocido o mal formado da 404.',
  })
  @ApiQuery({
    name: 'host',
    required: true,
    type: String,
    description:
      'Host de la página (subdominio de la plataforma o dominio propio verificado); el puerto se ignora.',
  })
  @ApiOkResponse({ type: BrandingDto })
  @ApiNotFoundResponse({ description: 'Ninguna clínica en ese host.' })
  branding(@Query('host') host: unknown): Promise<BrandingDto> {
    return this.getByHost.execute(host);
  }
}
