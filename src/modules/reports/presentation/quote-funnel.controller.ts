import { ExtraPermission } from '@prisma/client';
import {
  Controller,
  Get,
  Query,
  Req,
  Res,
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
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { AllowPermissions } from '../../auth/presentation/guards/permissions.decorator';
import {
  QUOTE_FUNNEL_CSV_ROLES,
  QUOTE_FUNNEL_REPORT_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { CSV_RESPONSE, sendCsv } from '../../../shared/csv/csv-response';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  GetQuoteFunnelUseCase,
  QUOTE_FUNNEL_INVALID_PERIOD_MESSAGE,
  QUOTE_FUNNEL_OWN_ONLY_MESSAGE,
  QUOTE_FUNNEL_PERIOD_TOO_LONG_MESSAGE,
  QUOTE_FUNNEL_REASON_NEEDS_REJECTED_MESSAGE,
  type QuoteFunnelInput,
  type QuoteFunnelPresentations,
  type QuoteFunnelReport,
} from '../application/use-cases/get-quote-funnel.use-case';
import { toQuoteFunnelCsv } from '../application/quote-funnel-csv';
import {
  QuoteFunnelPresentationsDto,
  QuoteFunnelPresentationsQueryDto,
  QuoteFunnelQueryDto,
  QuoteFunnelReportDto,
} from './dto/quote-funnel.dto';
import type { PermissionAwareRequest } from '../../auth/presentation/guards/roles.guard';

export const QUOTE_FUNNEL_FORBIDDEN_MESSAGE =
  'Solo la administración, los odontólogos y quien tenga acceso a los reportes financieros ven el embudo de presupuestos.';
export const QUOTE_FUNNEL_CSV_FORBIDDEN_MESSAGE =
  'Solo la administración descarga el embudo de presupuestos.';

interface AuthenticatedRequest extends PermissionAwareRequest {
  // RolesGuard ya exige un token de clínica (con rol).
  user: TenantJwtPayload;
}

const SCOPE =
  'Presupuestos PRESENTADOS en el período (la fecha de la primera presentación, en el día civil de la sede donde se presentó) y lo que pasó con ellos hasta hoy: aceptados, agendados, realizados y cobrados. ' +
  'Una presentación = un grupo de opciones A/B (cuenta una vez; importe = la opción de mayor total) con la cadena de pendientes de sus aceptaciones parciales (un pendiente no es otra presentación). ' +
  'Importes = precio − descuento en la moneda del CATÁLOGO: un plan en otra moneda se convierte con la tasa guardada en cada ítem; sin ella, la presentación cuenta en los números y queda fuera de los importes (`withoutRate`, aviso WITHOUT_RATE). ' +
  'ADMIN o quien tenga FINANCIAL_REPORTS_VIEW ve toda la clínica (scope CLINIC); un DENTIST, solo lo que elaboró (scope OWN). Solo las sedes que ve quien consulta (DX-089). `definitions` trae «Cómo se calcula». Sin datos de pacientes.';

const BAD_REQUEST = `${QUOTE_FUNNEL_INVALID_PERIOD_MESSAGE} / ${QUOTE_FUNNEL_PERIOD_TOO_LONG_MESSAGE} / filtros inválidos`;
const FORBIDDEN = `${QUOTE_FUNNEL_FORBIDDEN_MESSAGE} / ${QUOTE_FUNNEL_OWN_ONLY_MESSAGE} / No tienes acceso a esta sede.`;
const CONFLICT =
  'LOCATION_TIMEZONE_REQUIRED: una sede con presentaciones no tiene zona horaria';

// «Embudo de presupuestos» (DX-558). El agregado y el CSV no llevan datos de
// pacientes; el CSV sale de la clínica y queda auditado (EXPORT), como el
// detalle (VIEW), que sí lleva el nombre de cada paciente.
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...QUOTE_FUNNEL_REPORT_ROLES)
@RolesDeniedMessage(QUOTE_FUNNEL_FORBIDDEN_MESSAGE)
@Controller('reports')
export class QuoteFunnelController {
  constructor(
    private readonly funnel: GetQuoteFunnelUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  private input(
    query: QuoteFunnelQueryDto,
    req: AuthenticatedRequest,
  ): QuoteFunnelInput {
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
  @Get('quote-funnel')
  @ApiOperation({
    summary:
      'Embudo de presupuestos: presentados → aceptados → agendados → realizados → cobrados',
    description: SCOPE,
  })
  @ApiOkResponse({ type: QuoteFunnelReportDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiConflictResponse({ description: CONFLICT })
  get(
    @Query() query: QuoteFunnelQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<QuoteFunnelReport> {
    return this.funnel.execute(this.input(query, req));
  }

  @Audit({
    action: 'EXPORT',
    resource: 'TREATMENT_PLAN',
    reason: 'QUOTE_FUNNEL_REPORT',
  })
  @Roles(...QUOTE_FUNNEL_CSV_ROLES)
  @RolesDeniedMessage(QUOTE_FUNNEL_CSV_FORBIDDEN_MESSAGE)
  @Get('quote-funnel.csv')
  @ApiOperation({
    summary: 'Embudo de presupuestos en CSV (mismos filtros; solo ADMIN)',
    description: `${SCOPE} Una fila por profesional que lo elaboró y el «Total», con cada paso (número e importe), las tasas de aceptación y la mediana de días; cabecera con período, sede, profesional y moneda. UTF-8 con BOM; celdas protegidas contra fórmulas. Auditado (EXPORT).`,
  })
  @ApiProduces('text/csv')
  @ApiOkResponse(CSV_RESPONSE)
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({
    description: `${QUOTE_FUNNEL_CSV_FORBIDDEN_MESSAGE} / No tienes acceso a esta sede.`,
  })
  @ApiConflictResponse({ description: CONFLICT })
  async csv(
    @Query() query: QuoteFunnelQueryDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const report = await this.funnel.execute(this.input(query, req));
    sendCsv(
      res,
      `embudo-de-presupuestos-${report.period.from}-${report.period.to}.csv`,
    );
    return toQuoteFunnelCsv(report);
  }

  @Audit({
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    reason: 'QUOTE_FUNNEL_REPORT',
  })
  @AllowPermissions(ExtraPermission.FINANCIAL_REPORTS_VIEW)
  @Get('quote-funnel/presentations')
  @ApiOperation({
    summary: 'Detalle de una cifra del embudo: sus presentaciones',
    description: `Mismos filtros y alcance que el embudo, más el paso o desenlace (\`step\`) y, en las rechazadas, el motivo: cada presentación con paciente, fecha, sede, quién lo elaboró, opciones, importes de cada paso y desenlace, de la más reciente a la más antigua (${'`'}page${'`'}/${'`'}pageSize${'`'}, 25 por defecto, máx. 100). Lleva el nombre del paciente: auditado (VIEW). ${QUOTE_FUNNEL_REASON_NEEDS_REJECTED_MESSAGE}`,
  })
  @ApiOkResponse({ type: QuoteFunnelPresentationsDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiConflictResponse({ description: CONFLICT })
  presentations(
    @Query() query: QuoteFunnelPresentationsQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<QuoteFunnelPresentations> {
    return this.funnel.presentations({
      ...this.input(query, req),
      step: query.step,
      reason: query.reason,
      page: query.page,
      pageSize: query.pageSize,
    });
  }
}
