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
import { SkipThrottle } from '@nestjs/throttler';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { BrandingMissLimitInterceptor } from '../../../shared/security/branding-miss-limit.interceptor';

// DX-517-ter. PÚBLICA y SIN clínica en contexto: ni JwtAuthGuard/RolesGuard ni
// PublicTenantContextInterceptor (va en su propio controlador para no heredar
// el de `PublicBrandingController`). La clínica sale SOLO del parámetro
// `host`; las cabeceras de la petición (Host, X-Forwarded-Host, X-Tenant-Host,
// X-Tenant) no cuentan.
//
// Límites (DX-555): FUERA del global por IP, porque todas las llamadas salen
// de la IP del servidor web y un aluvión de hosts inventados agotaba ese
// balde y dejaba sin marca a las clínicas reales. En su lugar:
// - `branding-host`: por IP + host normalizado (guard), para los aciertos;
// - `branding-miss`: por IP, contando solo los 404 (host desconocido o mal
//   formado), en `BrandingMissLimitInterceptor`. Frena la enumeración desde
//   cualquier cliente sin tocar a las clínicas reales, que son aciertos.
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor, BrandingMissLimitInterceptor)
@Controller('public/tenant')
export class PublicBrandingByHostController {
  constructor(private readonly getByHost: GetTenantBrandingByHostUseCase) {}

  @Get('branding/by-host')
  @SkipThrottle({ default: true })
  @RateLimit('branding-host')
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
