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
import { QUOTE_FUNNEL_REPORT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  FOLLOW_UP_REPORT_INVALID_PERIOD_MESSAGE,
  FOLLOW_UP_REPORT_NO_TIME_ZONE_MESSAGE,
  FOLLOW_UP_REPORT_PERIOD_TOO_LONG_MESSAGE,
  GetQuoteFollowUpReportUseCase,
  type QuoteFollowUpReport,
} from '../application/quote-follow-up-report.use-case';
import {
  QuoteFollowUpReportDto,
  QuoteFollowUpReportQueryDto,
} from './dto/quote-follow-up.dto';

export const QUOTE_FOLLOW_UP_REPORT_FORBIDDEN_MESSAGE =
  'Solo la administración, los odontólogos y quien tenga acceso a los reportes financieros ven el seguimiento de presupuestos.';

interface AuthenticatedRequest extends PermissionAwareRequest {
  user: TenantJwtPayload;
}

/**
 * Reportes › Presupuestos › «Seguimiento automático» (DX-561, D5). Solo
 * recuentos y tasas (sin pacientes ni importes): sin @Audit, como el agregado
 * del embudo de DX-558. Mismo alcance que el embudo.
 */
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...QUOTE_FUNNEL_REPORT_ROLES)
@RolesDeniedMessage(QUOTE_FOLLOW_UP_REPORT_FORBIDDEN_MESSAGE)
@Controller('reports')
export class QuoteFollowUpReportController {
  constructor(
    private readonly report: GetQuoteFollowUpReportUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @AllowPermissions(ExtraPermission.FINANCIAL_REPORTS_VIEW)
  @Get('quote-follow-up')
  @ApiOperation({
    summary:
      'Efectividad del seguimiento automático: enviados, abiertos y aceptados en 14 días por aviso',
    description:
      'Avisos registrados en el período (día civil de la sede de la presentación): por paso 1..3 y en total, enviados, abiertos (alguna solicitud del aviso con openedAt), aceptados en los 14 días siguientes al envío (acceptedAt de cualquier opción del grupo en [sentAt, sentAt + 14 d]) y la tasa (aceptados ÷ enviados, en %); omitidos por motivo. ADMIN o FINANCIAL_REPORTS_VIEW: toda la clínica (scope CLINIC); un DENTIST, solo los presupuestos que elaboró (scope OWN). Solo las sedes que ve quien consulta (DX-089). `definitions` trae «Cómo se calcula». Sin datos de pacientes.',
  })
  @ApiOkResponse({ type: QuoteFollowUpReportDto })
  @ApiBadRequestResponse({
    description: `${FOLLOW_UP_REPORT_INVALID_PERIOD_MESSAGE} / ${FOLLOW_UP_REPORT_PERIOD_TOO_LONG_MESSAGE}`,
  })
  @ApiForbiddenResponse({
    description: `${QUOTE_FOLLOW_UP_REPORT_FORBIDDEN_MESSAGE} / No tienes acceso a esta sede.`,
  })
  @ApiConflictResponse({ description: FOLLOW_UP_REPORT_NO_TIME_ZONE_MESSAGE })
  get(
    @Query() query: QuoteFollowUpReportQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<QuoteFollowUpReport> {
    return this.report.execute({
      from: query.from,
      to: query.to,
      locationId: query.locationId,
      actor: {
        userId: req.user.sub,
        role: req.user.role,
        permissions: req.effectivePermissions ?? [],
      },
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
    });
  }
}
