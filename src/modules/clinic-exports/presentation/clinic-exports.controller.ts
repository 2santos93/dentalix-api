import {
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { isTenantPayload } from '../../../shared/crypto/token.service';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { CLINIC_EXPORT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import {
  ClinicExportsUseCases,
  type ClinicExportActor,
  type ClinicExportDownload,
} from '../application/clinic-exports.use-cases';
import {
  CLINIC_EXPORT_ALREADY_DOWNLOADED_MESSAGE,
  CLINIC_EXPORT_EXPIRED_MESSAGE,
  CLINIC_EXPORT_FORBIDDEN_MESSAGE,
  CLINIC_EXPORT_IN_PROGRESS_MESSAGE,
  CLINIC_EXPORT_NOT_FOUND_MESSAGE,
  CLINIC_EXPORT_NOT_READY_MESSAGE,
  type ClinicExportView,
} from '../domain/clinic-export';
import {
  ClinicExportDownloadDto,
  ClinicExportDto,
} from './dto/clinic-export.dto';

/**
 * DX-053: Ajustes › Exportar datos. Solo ADMIN (y miembro ADMIN activo de
 * verdad: ni el acceso de soporte ni un token con sedes restringidas). Todo
 * con `Cache-Control: no-store`: es un volcado de datos de salud. La petición
 * y la descarga quedan auditadas (CLINIC_EXPORT) por el caso de uso, en la
 * misma transacción que el cambio.
 */
@ApiTags('clinic-exports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINIC_EXPORT_ROLES)
@RolesDeniedMessage(CLINIC_EXPORT_FORBIDDEN_MESSAGE)
@ApiForbiddenResponse({ description: CLINIC_EXPORT_FORBIDDEN_MESSAGE })
@Controller('clinic-exports')
export class ClinicExportsController {
  constructor(
    private readonly exports: ClinicExportsUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  private actor(req: AuditableRequest): ClinicExportActor {
    const ctx = requireAuditRequestContext(req, this.tenantContext);
    const user = req.user;
    return {
      ctx,
      breakGlass: isTenantPayload(user) && user.breakGlass === true,
      restrictedToLocations: isTenantPayload(user) && user.loc !== undefined,
    };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Historial de exportaciones de la clínica (las 20 últimas)',
  })
  @ApiOkResponse({ type: [ClinicExportDto] })
  list(@Req() req: AuditableRequest): Promise<ClinicExportView[]> {
    return this.exports.list(this.actor(req));
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  @RateLimit('clinic-export')
  @ApiOperation({
    summary: 'Pedir una exportación completa (ZIP de CSV)',
    description:
      'Encola un trabajo que genera un ZIP con un CSV por entidad (UTF-8 con BOM, cabeceras en español). Al terminar avisa por email a todos los ADMIN. Una sola en curso por clínica.',
  })
  @ApiCreatedResponse({ type: ClinicExportDto })
  @ApiConflictResponse({ description: CLINIC_EXPORT_IN_PROGRESS_MESSAGE })
  request(@Req() req: AuditableRequest): Promise<ClinicExportView> {
    return this.exports.request(this.actor(req));
  }

  @Post(':id/download')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RateLimit('clinic-export')
  @ApiOperation({
    summary: 'Descargar una exportación (un solo uso)',
    description:
      'Consume el enlace de un solo uso (vale 24 h desde que está lista) y devuelve una URL firmada del almacén de 60 s. Queda auditado con el tamaño.',
  })
  @ApiOkResponse({ type: ClinicExportDownloadDto })
  @ApiNotFoundResponse({ description: CLINIC_EXPORT_NOT_FOUND_MESSAGE })
  @ApiConflictResponse({ description: CLINIC_EXPORT_NOT_READY_MESSAGE })
  @ApiGoneResponse({
    description: `${CLINIC_EXPORT_ALREADY_DOWNLOADED_MESSAGE} / ${CLINIC_EXPORT_EXPIRED_MESSAGE}`,
  })
  download(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuditableRequest,
  ): Promise<ClinicExportDownload> {
    return this.exports.download(id, this.actor(req));
  }
}
