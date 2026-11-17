import { ExtraPermission } from '@prisma/client';
import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import {
  RolesGuard,
  type PermissionAwareRequest,
} from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { AllowPermissions } from '../../auth/presentation/guards/permissions.decorator';
import { SCHEDULED_PRODUCTION_REPORT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  GetScheduledProductionUseCase,
  SCHEDULED_PRODUCTION_FORBIDDEN_MESSAGE,
  SCHEDULED_PRODUCTION_INVALID_PERIOD_MESSAGE,
  SCHEDULED_PRODUCTION_OWN_ONLY_MESSAGE,
  SCHEDULED_PRODUCTION_PERIOD_TOO_LONG_MESSAGE,
  type ScheduledProductionInput,
  type ScheduledProductionReport,
  type ScheduledProductionUnlinked,
} from '../application/use-cases/get-scheduled-production.use-case';
import { FORECAST_FORMULA } from '../domain/scheduled-production';
import {
  ScheduledProductionQueryDto,
  ScheduledProductionReportDto,
  ScheduledProductionUnlinkedDto,
  ScheduledProductionUnlinkedQueryDto,
} from './dto/scheduled-production.dto';

interface AuthenticatedRequest extends PermissionAwareRequest {
  // RolesGuard ya exige un token de clínica (con rol).
  user: TenantJwtPayload;
}

const SCOPE =
  'Lo agendado del período: procedimientos ACEPTADOS o ya REALIZADOS de un presupuesto ligados a citas que cuentan (vivas, ni canceladas ni inasistencias), por día civil de la cita (zona de su sede) y por profesional de la cita. Un procedimiento ligado a varias citas cuenta una vez, en la de inicio más reciente. ' +
  'Importes = precio − descuento en la moneda del CATÁLOGO, convertidos con la tasa GUARDADA del día (la de la cita; la de hoy si es futura; nunca se pide al proveedor): sin ella, ese importe queda fuera (`withoutRate`, aviso WITHOUT_RATE). ' +
  `Previsión del mes en curso (siempre, con los mismos filtros): ${FORECAST_FORMULA}. ` +
  'ADMIN o quien tenga FINANCIAL_REPORTS_VIEW ve toda la clínica (scope CLINIC); un DENTIST, solo lo suyo (scope OWN); recepción y asistente, nada. Solo las sedes que ve quien consulta (DX-089). `definitions` trae «Cómo se calcula». Sin datos de pacientes.';

const BAD_REQUEST = `${SCHEDULED_PRODUCTION_INVALID_PERIOD_MESSAGE} / ${SCHEDULED_PRODUCTION_PERIOD_TOO_LONG_MESSAGE} / filtros inválidos`;
const FORBIDDEN = `${SCHEDULED_PRODUCTION_FORBIDDEN_MESSAGE} / ${SCHEDULED_PRODUCTION_OWN_ONLY_MESSAGE} / No tienes acceso a esta sede.`;
const CONFLICT =
  'LOCATION_TIMEZONE_REQUIRED: una sede con citas o realizados no tiene zona horaria / LOCATION_REQUIRED: la clínica no tiene ninguna sede activa';

// «Producción agendada y previsión del mes» (DX-567). El agregado no lleva
// datos de pacientes; la lista de citas sin tratamiento ligado, sí (el
// nombre): queda auditada (VIEW).
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...SCHEDULED_PRODUCTION_REPORT_ROLES)
@RolesDeniedMessage(SCHEDULED_PRODUCTION_FORBIDDEN_MESSAGE)
@Controller('reports')
export class ScheduledProductionController {
  constructor(
    private readonly scheduled: GetScheduledProductionUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  private input(
    query: ScheduledProductionQueryDto,
    req: AuthenticatedRequest,
  ): ScheduledProductionInput {
    return {
      from: query.from,
      to: query.to,
      locationId: query.locationId,
      providerId: query.providerId,
      actor: {
        userId: req.user.sub,
        role: req.user.role,
        permissions: req.effectivePermissions ?? [],
      },
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
    };
  }

  @AllowPermissions(ExtraPermission.FINANCIAL_REPORTS_VIEW)
  @Get('scheduled-production')
  @ApiOperation({
    summary:
      'Producción agendada (por día y profesional), citas sin tratamiento y previsión del mes',
    description: SCOPE,
  })
  @ApiOkResponse({ type: ScheduledProductionReportDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiConflictResponse({ description: CONFLICT })
  get(
    @Query() query: ScheduledProductionQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduledProductionReport> {
    return this.scheduled.execute(this.input(query, req));
  }

  @Audit({
    action: 'VIEW',
    resource: 'APPOINTMENT',
    reason: 'SCHEDULED_PRODUCTION_REPORT',
  })
  @AllowPermissions(ExtraPermission.FINANCIAL_REPORTS_VIEW)
  @Get('scheduled-production/unlinked')
  @ApiOperation({
    summary: 'Citas sin tratamiento ligado del período',
    description: `Mismos filtros y alcance que la producción agendada: las citas que cuentan (ni canceladas ni inasistencias) sin ningún procedimiento de un presupuesto ligado, con paciente (\`patientArchived\`: archivado, sin enlace a su ficha), tipo, profesional y sede, por inicio (asc; \`page\`/\`pageSize\`, 25 por defecto, máx. 100). Lleva el nombre del paciente: auditado (VIEW).`,
  })
  @ApiOkResponse({ type: ScheduledProductionUnlinkedDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiConflictResponse({ description: CONFLICT })
  unlinked(
    @Query() query: ScheduledProductionUnlinkedQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduledProductionUnlinked> {
    return this.scheduled.unlinked({
      ...this.input(query, req),
      page: query.page,
      pageSize: query.pageSize,
    });
  }
}
