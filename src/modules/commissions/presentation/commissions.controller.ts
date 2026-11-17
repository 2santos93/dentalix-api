import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  COMMISSION_READ_ROLES,
  COMMISSION_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  COMMISSION_MESSAGES,
  CommissionUseCases,
  type CommissionActor,
} from '../application/commission.use-cases';
import type {
  CommissionPreviewView,
  CommissionRulesView,
  CommissionSettlementSummary,
  CommissionSettlementView,
  ProfessionalRuleView,
} from '../domain/views';
import {
  CloseCommissionSettlementDto,
  CommissionPreviewDto,
  CommissionPreviewQueryDto,
  CommissionRulesDto,
  CommissionSettlementDto,
  CommissionSettlementSummaryDto,
  CommissionSettlementsQueryDto,
  ProfessionalCommissionRuleDto,
  SaveCommissionRuleDto,
} from './dto/commission.dto';

interface AuthenticatedRequest extends AuditableRequest {
  user: TenantJwtPayload;
}

export const COMMISSION_FORBIDDEN_MESSAGE =
  'Los honorarios solo los ve administración y, lo suyo, cada odontólogo.';
export const COMMISSION_WRITE_FORBIDDEN_MESSAGE =
  'Solo administración configura las reglas de honorarios y cierra liquidaciones.';

const FORBIDDEN = `${COMMISSION_FORBIDDEN_MESSAGE} / ${COMMISSION_MESSAGES.allLocations}`;
const ZONE_CONFLICT =
  '`code: LOCATION_TIMEZONE_REQUIRED` si una sede implicada no tiene zona horaria válida.';

const actorOf = (req: AuthenticatedRequest): CommissionActor => ({
  userId: req.user.sub,
  role: req.user.role,
});

/**
 * DX-018: honorarios de odontólogos a porcentaje. Regla por profesional, vista
 * previa del período con el detalle por paciente, ítem y abono, cierre
 * (liquidación congelada que sube el cierre contable hasta su último día) y
 * consulta. Datos financieros: nada de importes en la auditoría ni en logs.
 */
@ApiTags('commissions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...COMMISSION_READ_ROLES)
@RolesDeniedMessage(COMMISSION_FORBIDDEN_MESSAGE)
@ApiForbiddenResponse({ description: FORBIDDEN })
@Controller('commissions')
export class CommissionsController {
  constructor(
    private readonly commissions: CommissionUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('rules')
  @Roles(...COMMISSION_WRITE_ROLES)
  @RolesDeniedMessage(COMMISSION_WRITE_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary: 'Profesionales con su regla de honorarios (solo ADMIN)',
    description:
      'Odontólogos y administradores vigentes (y quien ya tenga regla), con su regla o null, las categorías del catálogo y qué descuentos se pueden activar hoy.',
  })
  @ApiOkResponse({ type: CommissionRulesDto })
  listRules(@Req() req: AuthenticatedRequest): Promise<CommissionRulesView> {
    return this.commissions.listRules(actorOf(req));
  }

  // Auditado en el caso de uso (CLINIC_SETTINGS COMMISSION_RULE con el antes
  // y el después: base, modo, % y categorías; sin importes).
  @Put('rules/:userId')
  @Roles(...COMMISSION_WRITE_ROLES)
  @RolesDeniedMessage(COMMISSION_WRITE_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiOperation({
    summary:
      'Crea o cambia la regla de honorarios de un profesional (solo ADMIN)',
    description:
      'Base (lo cobrado o lo producido), cuándo se libera (por prestación o con el plan completo y pagado), % general y % por categoría. No cambia las liquidaciones ya cerradas (guardan su foto de la regla).',
  })
  @ApiOkResponse({ type: ProfessionalCommissionRuleDto })
  @ApiBadRequestResponse({
    description:
      '% fuera de 0–100 o con más de 2 decimales, categoría vacía o repetida, profesional que no es odontólogo ni administrador o ya retirado, o un descuento aún no disponible',
  })
  @ApiNotFoundResponse({ description: COMMISSION_MESSAGES.notFound })
  saveRule(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SaveCommissionRuleDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ProfessionalRuleView> {
    return this.commissions.saveRule(
      actorOf(req),
      userId,
      {
        basis: dto.basis,
        releaseMode: dto.releaseMode,
        percent: dto.percent,
        categories: dto.categories?.map((c) => ({
          category: c.category,
          percent: c.percent,
        })),
        active: dto.active,
        deductLabCost: dto.deductLabCost,
        deductCardFee: dto.deductCardFee,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Audit({
    action: 'VIEW',
    resource: 'COMMISSION_SETTLEMENT',
    reason: 'COMMISSION_PREVIEW',
  })
  @Get('preview')
  @ApiOperation({
    summary: 'Vista previa de la liquidación de un período',
    description:
      'Devengos del período con el detalle por paciente, ítem y abono, más los ajustes de liquidaciones anteriores (abonos anulados después del cierre…), con los totales por moneda. Dice si se puede cerrar y, si no, por qué. ADMIN, de cualquier profesional; un DENTIST, solo la suya. Lleva nombres de pacientes: auditado (VIEW).',
  })
  @ApiOkResponse({ type: CommissionPreviewDto })
  @ApiBadRequestResponse({
    description: 'Período inválido o de más de 366 días',
  })
  @ApiNotFoundResponse({ description: COMMISSION_MESSAGES.notFound })
  @ApiConflictResponse({ description: ZONE_CONFLICT })
  preview(
    @Query() query: CommissionPreviewQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CommissionPreviewView> {
    return this.commissions.preview(actorOf(req), {
      userId: query.userId,
      from: query.from,
      to: query.to,
    });
  }

  // Auditado en el caso de uso (CREATE COMMISSION_SETTLEMENT, y el cambio del
  // cierre contable como CLINIC_SETTINGS FINANCIAL_LOCK).
  @Post('settlements')
  @HttpCode(201)
  @Roles(...COMMISSION_WRITE_ROLES)
  @RolesDeniedMessage(COMMISSION_WRITE_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary: 'Cierra la liquidación de un período (solo ADMIN)',
    description:
      'Congela el detalle (no cambia nunca más: lo que se anule después sale como ajuste en la siguiente) y sube el cierre contable de la clínica hasta el último día del período (nunca lo retrocede). El período tiene que haber terminado, no solaparse con otra liquidación del profesional y empezar el día siguiente a la última.',
  })
  @ApiCreatedResponse({ type: CommissionSettlementDto })
  @ApiBadRequestResponse({
    description: 'Período inválido o de más de 366 días',
  })
  @ApiNotFoundResponse({ description: COMMISSION_MESSAGES.notFound })
  @ApiConflictResponse({
    description:
      '`code: COMMISSION_CANNOT_CLOSE` con `blocker` (sin regla, regla desactivada, período sin terminar, solapado o con hueco tras la anterior); `COMMISSION_PERIOD_OVERLAP`; ' +
      ZONE_CONFLICT,
  })
  close(
    @Body() dto: CloseCommissionSettlementDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CommissionSettlementView> {
    return this.commissions.close(
      actorOf(req),
      { userId: dto.userId, from: dto.from, to: dto.to },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Get('settlements')
  @ApiOperation({
    summary: 'Liquidaciones cerradas, de la más reciente a la más antigua',
    description:
      'Cabecera y totales por moneda (sin pacientes). ADMIN, todas o las de un profesional; un DENTIST, solo las suyas.',
  })
  @ApiOkResponse({ type: [CommissionSettlementSummaryDto] })
  listSettlements(
    @Query() query: CommissionSettlementsQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CommissionSettlementSummary[]> {
    return this.commissions.listSettlements(actorOf(req), query.userId);
  }

  @Audit({
    action: 'VIEW',
    resource: 'COMMISSION_SETTLEMENT',
    resourceId: { param: 'id' },
    reason: 'COMMISSION_SETTLEMENT',
  })
  @Get('settlements/:id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Una liquidación cerrada con su detalle congelado',
    description:
      'ADMIN, cualquiera; un DENTIST, solo las suyas (otra → 404). Lleva nombres de pacientes: auditado (VIEW).',
  })
  @ApiOkResponse({ type: CommissionSettlementDto })
  @ApiNotFoundResponse({ description: COMMISSION_MESSAGES.settlementNotFound })
  getSettlement(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<CommissionSettlementView> {
    return this.commissions.getSettlement(actorOf(req), id);
  }
}
