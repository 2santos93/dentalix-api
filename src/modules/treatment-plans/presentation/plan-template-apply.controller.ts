import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
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
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import {
  ROLES_DENIED_DEFAULT_MESSAGE,
  RolesGuard,
} from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import {
  isTenantPayload,
  type JwtPayload,
} from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  CURRENCY_DIGITS_CATALOG,
  type CurrencyDigits,
  type CurrencyDigitsCatalog,
} from '../../../shared/money/currency-digits';
import { DrainAllocationRebalancesInterceptor } from '../../payments/presentation/drain-allocation-rebalances.interceptor';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  ApplyPlanTemplateUseCase,
  type TemplateApplication,
  type TemplatePreview,
} from '../application/use-cases/apply-plan-template.use-case';
import { GetTreatmentPlanUseCase } from '../application/use-cases/get-treatment-plan.use-case';
import { QuoteExpiry } from '../application/quote-expiry';
import type { DiscountActor } from '../application/use-cases/item-discount';
import type { TreatmentPlanDetail } from '../domain/entities/treatment-plan.entity';
import {
  ApplyPlanTemplateDto,
  PreviewPlanTemplateDto,
  TemplateApplicationDto,
  TemplatePreviewDto,
} from './dto/apply-plan-template.dto';

interface AuthenticatedRequest extends AuditableRequest {
  user: JwtPayload;
}

const NOT_FOUND =
  'Plan o plantilla inexistente o de otra clínica (también una plantilla de otra clínica: el mismo 404)';
const CONFLICT =
  '`code` PLAN_TEMPLATE_PLAN_NOT_EDITABLE: el plan no está en borrador ni presentado, o está firmado (también ACEPTADO sin firma; el mensaje nombra el estado y el cuerpo lleva `status`); PLAN_TEMPLATE_INACTIVE: la plantilla está desactivada; PLAN_TEMPLATE_VISIT_OVERFLOW: una visita o un intervalo desplazado pasaría de 1000';

/** El usuario y el rol del token (TenantContextInterceptor ya exige uno de clínica). */
function actorOf(req: AuthenticatedRequest): DiscountActor {
  if (!isTenantPayload(req.user)) {
    throw new ForbiddenException(ROLES_DENIED_DEFAULT_MESSAGE);
  }
  return { role: req.user.role, userId: req.user.sub };
}

// DX-559: aplicar una plantilla de plan. Mismos roles que «añadir ítem»
// (CLINICAL_ROLES, sin recepción). La vista previa no escribe nada; aplicar
// crea los ítems en una transacción y escribe en ella el evento UPDATE
// TREATMENT_PLAN PLAN_TEMPLATE_APPLIED (con `templateId` y el nº de ítems).
@ApiTags('treatment-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
// DX-051: detrás del tenant, en el MISMO decorador (corre en su contexto).
@UseInterceptors(TenantContextInterceptor, DrainAllocationRebalancesInterceptor)
@Roles(...CLINICAL_ROLES)
@Controller('treatment-plans')
export class PlanTemplateApplyController {
  constructor(
    private readonly applyTemplate: ApplyPlanTemplateUseCase,
    private readonly getTreatmentPlan: GetTreatmentPlanUseCase,
    private readonly quoteExpiry: QuoteExpiry,
    private readonly tenantContext: TenantContextService,
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly currencyDigits: CurrencyDigitsCatalog,
  ) {}

  @Post(':id/apply-template/preview')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Vista previa de una plantilla sobre el plan (no escribe nada)',
    description:
      'Por línea: visita destino, precio vigente del paciente (sin descuento) y su fuente, total de la línea y si se omite (procedimiento desactivado). Una línea sin precio no falla: `priceMissing`. Total en la moneda del plan.',
  })
  @ApiOkResponse({ type: TemplatePreviewDto })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: CONFLICT })
  @ApiForbiddenResponse({ description: 'Recepción no arma planes' })
  preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PreviewPlanTemplateDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<TemplatePreview> {
    return this.applyTemplate.preview(id, dto.templateId, actorOf(req));
  }

  @Post(':id/apply-template')
  @ApiOperation({
    summary: 'Añadir al plan los procedimientos de una plantilla',
    description:
      'Crea N ítems por línea (cantidad) detrás de la última visita viva del plan, con el precio vigente del paciente y sin descuento, y fusiona los días entre visitas sin pisar los del plan. Todo o nada. Las líneas de procedimientos desactivados se omiten y se listan en `skipped`.',
  })
  @ApiCreatedResponse({ type: TemplateApplicationDto })
  @ApiBadRequestResponse({
    description:
      '`code` PLAN_TEMPLATE_TOOTH_REQUIRED: una línea aplicable sin diente (el cuerpo lleva `lineId`); PLAN_TEMPLATE_UNKNOWN_LINE: un `lines[].lineId` no es de la plantilla. Nada se crea',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: CONFLICT })
  @ApiUnprocessableEntityResponse({
    description:
      '`code` PLAN_TEMPLATE_PRICE_MISSING: una línea sin precio en la moneda del plan; DISCOUNT_REFERENCE_RATE_MISSING: falta la tasa del día (los dos con `lineId`); PLAN_TEMPLATE_NOTHING_TO_APPLY: ninguna línea aplicable. Nada se crea',
  })
  @ApiForbiddenResponse({ description: 'Recepción no arma planes' })
  async apply(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyPlanTemplateDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<
    TemplateApplication & {
      plan: TreatmentPlanDetail & {
        quoteExpired: boolean;
        currencyDigits: CurrencyDigits;
      };
    }
  > {
    const result = await this.applyTemplate.apply(
      id,
      {
        templateId: dto.templateId,
        toothNumber: dto.toothNumber,
        lines: dto.lines,
      },
      actorOf(req),
      requireAuditRequestContext(req, this.tenantContext),
    );
    const plan = await this.quoteExpiry.one(
      await this.getTreatmentPlan.execute(id),
    );
    const digits = await this.currencyDigits.table([plan.currency]);
    return {
      ...result,
      plan: { ...plan, currencyDigits: digits.of(plan.currency) },
    };
  }
}
