import {
  Controller,
  Get,
  Query,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { AUDIT_READ_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  ListAuditEventsUseCase,
  type ListAuditEventsOutput,
  MAX_LIMIT,
  MAX_RANGE_DAYS,
} from '../application/list-audit-events.use-case';
import { ListAuditEventsQueryDto } from './dto/list-audit-events-query.dto';
import { AuditEventsPageDto } from './dto/audit-event.dto';

/**
 * Registro de auditoría de la clínica (DX-009). Solo ADMIN: incluye IP y user
 * agent de cada acceso. Aislado por clínica (RLS). Leerlo no deja evento.
 */
@ApiTags('audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...AUDIT_READ_ROLES)
@Controller('audit-events')
export class AuditEventsController {
  constructor(
    private readonly listEvents: ListAuditEventsUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Auditoría: quién vio o cambió datos clínicos y financieros',
    description:
      'Más reciente primero, paginado por cursor (`nextCursor`). Por defecto ' +
      `los últimos 30 días; el rango no puede superar ${MAX_RANGE_DAYS} días ` +
      `y \`limit\` como mucho ${MAX_LIMIT}. Ningún evento lleva contenido ` +
      'clínico: solo ids, nombres de campos y códigos.',
  })
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description:
      'Sede activa: solo fija la zona de referencia (`timeZone`). Los ' +
      'eventos son de toda la clínica.',
  })
  @ApiOkResponse({ type: AuditEventsPageDto })
  @ApiBadRequestResponse({
    description:
      'Filtro inválido, from >= to, rango de más de 366 días, cursor ' +
      'manipulado o limit fuera de 1–100.',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  list(
    @Query() query: ListAuditEventsQueryDto,
  ): Promise<ListAuditEventsOutput> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new UnauthorizedException('No tenant in context');
    return this.listEvents.execute({
      tenantId,
      locationId: this.tenantContext.getLocationId(),
      ...query,
    });
  }
}
