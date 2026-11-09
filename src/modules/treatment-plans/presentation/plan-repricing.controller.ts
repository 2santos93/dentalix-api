import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
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
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import {
  isTenantPayload,
  type JwtPayload,
} from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { DrainAllocationRebalancesInterceptor } from '../../payments/presentation/drain-allocation-rebalances.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import type { AuditableRequest } from '../../audit/presentation/audit-request-context';
import { lineCents } from '../../../shared/money/line-rounding';
import { fromCents, toCents } from '../../../shared/money/money';
import {
  ApplyPlanRepricingUseCase,
  PreviewPlanRepricingUseCase,
} from '../application/use-cases/plan-repricing.use-cases';
import type { ItemPriceState, Repricing } from '../application/repricing';
import type { RepricingRecord } from '../domain/ports/plan-repricing-repository.port';
import {
  AppliedRepricingDto,
  ApplyRepricingDto,
  RepricePlanDto,
  RepricingPreviewDto,
  type RepricingPriceDto,
} from './dto/plan-repricing.dto';

interface AuthenticatedRequest extends AuditableRequest {
  user: JwtPayload;
  auditMetadata?: Record<string, unknown>;
  skipAudit?: boolean;
}

function actorOf(req: AuthenticatedRequest) {
  if (!isTenantPayload(req.user)) {
    throw new ForbiddenException('Insufficient role');
  }
  return { role: req.user.role, userId: req.user.sub };
}

function priceDto(state: ItemPriceState): RepricingPriceDto {
  return {
    price: state.price,
    discount: state.discount,
    total: fromCents(lineCents(state)),
    listPrice: state.reference.referencePriceInPlan,
    priceSource: state.priceSource,
    agreementId: state.agreementId,
    agreementName: state.agreementName,
  };
}

type RepricingView = Omit<Repricing, 'lines'> & {
  lines: Omit<Repricing['lines'][number], 'discountDecision'>[];
};

function toPreviewDto(r: RepricingView): RepricingPreviewDto {
  return {
    planId: r.planId,
    currency: r.currency,
    previewHash: r.previewHash,
    lines: r.lines.map((line) => ({
      itemId: line.itemId,
      catalogItemId: line.catalogItemId,
      toothNumber: line.toothNumber,
      before: priceDto(line.before),
      after: priceDto(line.after),
      difference: fromCents(lineCents(line.after) - lineCents(line.before)),
      changed: line.changed,
    })),
    skipped: r.skipped.map((skip) => ({ ...skip })),
    rate: r.rate ? { ...r.rate } : null,
    previousValidity: r.previousValidity ? { ...r.previousValidity } : null,
    validityRenewed: r.validityRenewed,
    validityNote: r.validityNote,
    validity: r.validity ? { ...r.validity } : null,
    totals: {
      before: r.totals.before,
      after: r.totals.after,
      difference: fromCents(toCents(r.totals.after) - toCents(r.totals.before)),
    },
  };
}

function toAppliedDto(
  record: RepricingRecord,
  replayed: boolean,
): AppliedRepricingDto {
  return {
    ...toPreviewDto({
      planId: record.planId,
      currency: record.currency,
      previewHash: record.previewHash,
      lines: record.lines,
      skipped: record.skipped,
      rate: record.rate,
      previousValidity: record.previousValidity,
      validityRenewed: record.validityRenewed,
      validityNote: record.validityNote,
      validity: record.validity,
      totals: record.totals,
    }),
    repricingId: record.id,
    appliedAt: record.createdAt.toISOString(),
    replayed,
  };
}

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description:
    'Sede de escritura: la de la lista de precios y la tasa de hoy (como al dar de alta un ítem) y la que firma un descuento. Sin ella, la principal. La validez se fecha con la sede del plan (la de su presentación o, sin presentar, esta).',
};

const NOT_OPEN_CONFLICT =
  'El plan no se puede recotizar: aceptado (con o sin firma), cancelado, rechazado o completado; con abonos vivos, plan de cuotas activo o saldo a favor; un ítem pedido no está propuesto o es el cargo vigente por inasistencia (SEC-050); o `LOCATION_TIMEZONE_REQUIRED` (la sede del plan no tiene zona horaria válida)';
const DISCOUNT_FORBIDDEN =
  'SEC-041: el redondeo del precio nuevo sube el % de descuento efectivo de un ítem por encima del tope del rol de quien recotiza (nada cambia). Si no lo sube, el descuento conserva su motivo y la firma de quien lo dio';

// DX-379 (porción B): «Actualizar precios» (recotizar). Los mismos roles que
// editan los ítems del plan (CLINICAL_ROLES: DENTIST, ASSISTANT, ADMIN; NO
// recepción), como `TreatmentPlansController`.
@ApiTags('treatment-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
// DX-051: detrás del tenant, en el MISMO decorador (corre en su contexto).
@UseInterceptors(TenantContextInterceptor, DrainAllocationRebalancesInterceptor)
@Roles(...CLINICAL_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@ApiParam({ name: 'planId', format: 'uuid' })
@ApiHeader(LOCATION_HEADER)
@Controller('patients/:patientId/treatment-plans/:planId/reprice')
export class PlanRepricingController {
  constructor(
    private readonly previewRepricing: PreviewPlanRepricingUseCase,
    private readonly applyRepricing: ApplyPlanRepricingUseCase,
  ) {}

  @Audit({
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'planId' },
    patient: { param: 'patientId' },
    reason: 'REPRICE_PREVIEW',
  })
  @Post('preview')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Vista previa de «Actualizar precios» (DX-379), sin escribir',
    description:
      'Cada ítem propuesto con el precio que tendría hoy (la misma resolución que el alta: convenio → lista de la sede → catálogo, convertido con la tasa de hoy si el catálogo está en otra moneda), conservando la proporción precio / lista y descuento / precio. Los que no tienen precio vigente o tasa se listan sin tocarlos. Devuelve la huella que exige `/reprice/apply`.',
  })
  @ApiOkResponse({ type: RepricingPreviewDto })
  @ApiNotFoundResponse({
    description:
      'Paciente o plan no encontrados en esta clínica, el plan es de otro paciente, o algún ítem pedido no es de este plan',
  })
  @ApiConflictResponse({ description: NOT_OPEN_CONFLICT })
  @ApiForbiddenResponse({
    description: `Recepción no recotiza (dato clínico). ${DISCOUNT_FORBIDDEN}`,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'SEC-041: el redondeo sube el % efectivo por encima del umbral y el ítem no tiene motivo de descuento',
  })
  async preview(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: RepricePlanDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<RepricingPreviewDto> {
    const repricing = await this.previewRepricing.execute(
      patientId,
      planId,
      { itemIds: dto.itemIds },
      actorOf(req),
    );
    return toPreviewDto(repricing);
  }

  // Un evento UPDATE TREATMENT_PLAN con reason PLAN_REPRICED y la fila de la
  // recotización en `params.repricingId` (DX-273): los importes, el antes y
  // el después y el autor viven en esa fila, nunca en la auditoría (DX-009).
  @Audit({
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'planId' },
    patient: { param: 'patientId' },
    reason: 'PLAN_REPRICED',
  })
  @Post('apply')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Aplica «Actualizar precios» (DX-379) con la huella de la vista previa',
    description:
      'Recalcula la recotización con el plan bloqueado (la misma función que la vista previa) y, si su huella es `previewHash`, escribe en una transacción los precios y la foto de cada ítem, reinicia la validez del presupuesto solo si se recotizan TODOS los ítems propuestos vivos (`validityRenewed`; emitido hoy en la sede del plan + días del ajuste; un borrador sin fechas queda con fechas; si no, conserva la que tenía) y guarda la recotización con el antes y el después. Un enlace de firma a distancia (DX-415) pendiente deja de valer si el presupuesto cambió.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'UUID por intento (uno por apertura de la vista previa). Repetir la MISMA petición con la misma clave devuelve la recotización ya aplicada (`replayed: true`) sin volver a escribir ni auditar; otra petición con la misma clave es 422 `IDEMPOTENCY_KEY_REUSED`. Por clínica; vive con la recotización.',
  })
  @ApiOkResponse({ type: AppliedRepricingDto })
  @ApiBadRequestResponse({
    description:
      'Falta la cabecera Idempotency-Key o no es un UUID; `previewHash` no es una huella; ítems inválidos',
  })
  @ApiNotFoundResponse({
    description:
      'Paciente o plan no encontrados en esta clínica, el plan es de otro paciente, o algún ítem pedido no es de este plan',
  })
  @ApiConflictResponse({
    description: `${NOT_OPEN_CONFLICT}; \`REPRICE_PREVIEW_STALE\` («Los precios vigentes cambiaron desde la vista previa: revísala de nuevo.»): la huella ya no coincide (cambió un precio, la tasa, un ítem o el día) y nada cambia; \`REPRICE_NOTHING_TO_APPLY\`: ningún ítem propuesto tiene precio vigente`,
  })
  @ApiForbiddenResponse({
    description: `Recepción no recotiza (dato clínico). ${DISCOUNT_FORBIDDEN}`,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`IDEMPOTENCY_KEY_REUSED`: la clave ya se usó para otra petición (otro plan, otra vista previa u otros ítems); o SEC-041: el redondeo sube el % efectivo por encima del umbral y el ítem no tiene motivo',
  })
  async apply(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: ApplyRepricingDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<AppliedRepricingDto> {
    const { record, replayed } = await this.applyRepricing.execute(
      patientId,
      planId,
      { itemIds: dto.itemIds, previewHash: dto.previewHash },
      actorOf(req),
      idempotencyKey,
    );
    // Una repetición no vuelve a auditar (como gastos y salidas de caja).
    if (replayed) req.skipAudit = true;
    else req.auditMetadata = { params: { repricingId: record.id } };
    return toAppliedDto(record, replayed);
  }
}
