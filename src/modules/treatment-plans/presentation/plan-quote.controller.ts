import {
  Body,
  Controller,
  ForbiddenException,
  Get,
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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  TREATMENT_PLAN_DECISION_ROLES,
  TREATMENT_PLAN_QUOTE_READ_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import {
  isTenantPayload,
  type JwtPayload,
} from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { DrainAllocationRebalancesInterceptor } from '../../payments/presentation/drain-allocation-rebalances.interceptor';
import {
  AcceptTreatmentPlanUseCase,
  GetPlanQuoteUseCase,
  IssuePlanQuoteUseCase,
  PreviewAcceptanceRepricingUseCase,
  PreviewPartialAcceptanceUseCase,
  type PlanQuoteDocument,
} from '../application/use-cases/plan-quote.use-cases';
import {
  AcceptanceRepricePreviewDto,
  AcceptTreatmentPlanDto,
  PartialAcceptancePreviewDto,
  PartialAcceptancePreviewRequestDto,
  PlanQuoteDocumentDto,
} from './dto/plan-quote.dto';
import { Audit } from '../../audit/presentation/audit.decorator';
import { expiredAcceptanceAuditReason } from '../domain/expired-quote-acceptance';
import { toPreviewDto } from './plan-repricing.controller';

type AuthenticatedRequest = Request & {
  user: JwtPayload;
  auditMetadata?: Record<string, unknown>;
};

/** Usuario y rol del token de clínica (el rol cuenta para los topes de descuento). */
function actorOf(req: AuthenticatedRequest) {
  if (!isTenantPayload(req.user)) {
    throw new ForbiddenException('Insufficient role');
  }
  return { userId: req.user.sub, role: req.user.role };
}

const USER_AGENT_MAX = 512;

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description:
    'Sede cuyos datos encabezan el presupuesto (y en la que se firma). Sin ella, la sede principal. Un plan ya aceptado muestra la sede en la que se firmó.',
};

/**
 * Lo que la firma añade a su evento (sin importes: están en la fila de la
 * aceptación). DX-379 (C): un presupuesto vencido dice cómo se aceptó y, al
 * recotizar, `params.repricingId`. DX-417: una aceptación parcial lleva
 * `params.pendingPlanId` y, si no estaba vencido, `reason`
 * PLAN_PARTIALLY_ACCEPTED (con vencido manda el `reason` de DX-379 C).
 */
export function acceptanceAuditMetadata(
  doc: PlanQuoteDocument,
): Record<string, unknown> | undefined {
  const acceptance = doc.acceptance;
  if (!acceptance) return undefined;
  const params: Record<string, string> = {};
  if (acceptance.repricingId) params.repricingId = acceptance.repricingId;
  if (acceptance.pendingPlanId) params.pendingPlanId = acceptance.pendingPlanId;
  const reason = acceptance.expiredMode
    ? expiredAcceptanceAuditReason(acceptance.expiredMode)
    : acceptance.pendingPlanId
      ? 'PLAN_PARTIALLY_ACCEPTED'
      : undefined;
  if (!reason) return undefined;
  return {
    reason,
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}

/** La firma sale como data URL, lista para un `<img>`; nunca IP ni UA. */
function toDto(doc: PlanQuoteDocument): PlanQuoteDocumentDto {
  return {
    ...doc,
    acceptance: doc.acceptance
      ? {
          ...doc.acceptance,
          signature: `data:image/png;base64,${doc.acceptance.signature}`,
        }
      : null,
  };
}

// Presupuesto imprimible y aceptación firmada (DX-012). Sin @Patch ni @Delete
// A PROPÓSITO: una aceptación firmada es inmutable (trigger de la base,
// 20261016213000_treatment_plan_acceptances).
@ApiTags('treatment-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
// DX-051: detrás del tenant, en el MISMO decorador (corre en su contexto).
@UseInterceptors(TenantContextInterceptor, DrainAllocationRebalancesInterceptor)
@ApiParam({ name: 'patientId', format: 'uuid' })
@ApiParam({ name: 'planId', format: 'uuid' })
@ApiHeader(LOCATION_HEADER)
@Controller('patients/:patientId/treatment-plans/:planId')
export class PlanQuoteController {
  constructor(
    private readonly getQuote: GetPlanQuoteUseCase,
    private readonly issueQuote: IssuePlanQuoteUseCase,
    private readonly acceptPlan: AcceptTreatmentPlanUseCase,
    private readonly previewAcceptanceRepricing: PreviewAcceptanceRepricingUseCase,
    private readonly previewPartialAcceptance: PreviewPartialAcceptanceUseCase,
  ) {}

  @Audit({
    action: 'PRINT',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'planId' },
    patient: { param: 'patientId' },
  })
  @Get('quote')
  @Roles(...TREATMENT_PLAN_QUOTE_READ_ROLES)
  @ApiOkResponse({ type: PlanQuoteDocumentDto })
  @ApiNotFoundResponse({
    description:
      'Paciente o plan no encontrados en esta clínica (o el plan es de otro paciente)',
  })
  async quote(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ): Promise<PlanQuoteDocumentDto> {
    return toDto(await this.getQuote.execute(patientId, planId));
  }

  // DX-379 (D-2): imprimir. La primera impresión fija la validez del
  // presupuesto si el plan aún no la tiene; el GET de arriba sigue siendo de
  // solo lectura (el modal de aceptar lo usa para ver).
  @Audit({
    action: 'PRINT',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'planId' },
    patient: { param: 'patientId' },
  })
  @Post('quote/issue')
  @HttpCode(200)
  @Roles(...TREATMENT_PLAN_QUOTE_READ_ROLES)
  @ApiOperation({
    summary:
      'Imprime el presupuesto: la primera impresión fija su validez (DX-379)',
    description:
      'Devuelve lo mismo que GET quote. Si el plan está en borrador o presentado, sin firmar y sin validez guardada, la fija: emitido hoy (día de la sede) y válido los días del ajuste de la clínica (GET /treatment-plan-settings). Presentar el plan también la fija. Reimprimir otro día, o tras cambiar el ajuste, devuelve las mismas fechas. Idempotente; queda en la auditoría como PRINT.',
  })
  @ApiOkResponse({ type: PlanQuoteDocumentDto })
  @ApiNotFoundResponse({
    description:
      'Paciente o plan no encontrados en esta clínica (o el plan es de otro paciente)',
  })
  async issue(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ): Promise<PlanQuoteDocumentDto> {
    return toDto(await this.issueQuote.execute(patientId, planId));
  }

  @Audit({
    action: 'SIGN',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'planId' },
    patient: { param: 'patientId' },
  })
  @Post('acceptance')
  @Roles(...TREATMENT_PLAN_DECISION_ROLES)
  @ApiCreatedResponse({
    type: PlanQuoteDocumentDto,
    description:
      'Plan aceptado: ACCEPTED, sus ítems propuestos pasan a aceptados y quedan congelados; las demás opciones abiertas de su grupo pasan a REJECTED (otra opción aceptada) en la misma transacción. DX-417: con `partial`, el plan queda ACCEPTED solo con los elegidos (lo firmado es su presupuesto) y los demás pasan a un plan nuevo PRESENTED, fuera del grupo de opciones, enlazado (`splitFromPlanId`) y con la misma presentación, validez, moneda y profesional; `acceptance.pendingPlanId`, `pendingItemIds` y `pendingTotal` lo dicen',
  })
  @ApiBadRequestResponse({
    description:
      'Sin firma, firma no PNG o de más de 200 KB, sin nombre de quien firma, o plan sin ítems. DX-379 (C): `expired` con un presupuesto no vencido; ORIGINAL_PRICES sin motivo, OTHER sin nota, nota de más de 200; REPRICE sin `repricePreviewHash` o con motivo. DX-417: `partial` sin elegir ninguno, eligiendo todos («Has elegido todos los procedimientos: acéptalo entero.»), más de 100, o dejando fuera uno ya aceptado o realizado',
  })
  @ApiNotFoundResponse({
    description:
      'Paciente o plan no encontrados en esta clínica. DX-417: algún ítem de `partial` no es de este plan',
  })
  @ApiConflictResponse({
    description:
      'Ya estaba aceptado y firmado, el plan está rechazado, cancelado o completado, otra opción de su grupo ya está aceptada, o el presupuesto cambió desde que se mostró (contentHash). DX-379 (C): la sede de la presentación del plan sin zona válida → `LOCATION_TIMEZONE_REQUIRED` (también con un presupuesto no vencido si tiene validez guardada); `code: QUOTE_EXPIRED` («El presupuesto venció el {fecha}. Actualiza los precios o acepta con los precios originales indicando el motivo.», con `quoteValidUntil`) si está vencido y no llega `expired`; con REPRICE, `REPRICE_PREVIEW_STALE` (los precios vigentes cambiaron desde la vista previa), `REPRICE_INCOMPLETE` (algún propuesto sin precio vigente o sin tasa), `REPRICE_NOTHING_TO_APPLY` o el plan no se recotiza (abonos, plan de cuotas, saldo a favor); nada se escribe. DX-417 con `partial`: `PARTIAL_PLAN_NOT_PRESENTED` (solo un presupuesto presentado se acepta en parte), `PARTIAL_PLAN_ALREADY_ACCEPTED`, o el plan tiene abonos, plan de cuotas activo o saldo a favor',
  })
  @ApiForbiddenResponse({
    description:
      'Solo odontólogo y ADMIN aceptan (DX-040): la asistente lo ve pero no lo acepta; recepción imprime el presupuesto pero no lo acepta',
  })
  async accept(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: AcceptTreatmentPlanDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PlanQuoteDocumentDto> {
    const userAgent = req.get('user-agent');
    const actor = actorOf(req);
    const doc = await this.acceptPlan.execute(
      patientId,
      planId,
      {
        signerName: dto.signerName,
        signature: dto.signature,
        contentHash: dto.contentHash,
        expired: dto.expired,
        partial: dto.partial ? { itemIds: dto.partial.itemIds } : undefined,
      },
      {
        acceptedById: actor.userId,
        role: actor.role,
        ipAddress: req.ip ?? null,
        userAgent: userAgent ? userAgent.slice(0, USER_AGENT_MAX) : null,
      },
    );
    const audit = acceptanceAuditMetadata(doc);
    if (audit) req.auditMetadata = audit;
    return toDto(doc);
  }

  // DX-379 (C): la vista previa de «actualizar los precios» al aceptar un
  // presupuesto vencido. Lee el plan (VIEW) y no escribe nada.
  @Audit({
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'planId' },
    patient: { param: 'patientId' },
    reason: 'ACCEPT_REPRICE_PREVIEW',
  })
  @Post('acceptance/reprice-preview')
  @HttpCode(200)
  @Roles(...TREATMENT_PLAN_DECISION_ROLES)
  @ApiOperation({
    summary:
      'Vista previa del presupuesto con los precios actualizados para aceptarlo vencido (DX-379)',
    description:
      'Recotiza TODOS los ítems propuestos con el precio vigente (la misma función que …/reprice/preview) y compone el presupuesto como se firmaría (precios y validez nuevos), sin escribir nada. Para aceptar con `expired.mode = REPRICE` se envían `repricing.previewHash` (como `expired.repricePreviewHash`) y `quote.contentHash` (como `contentHash`).',
  })
  @ApiOkResponse({ type: AcceptanceRepricePreviewDto })
  @ApiNotFoundResponse({
    description:
      'Paciente o plan no encontrados en esta clínica (o el plan es de otro paciente)',
  })
  @ApiConflictResponse({
    description:
      'Ya firmado, el plan no admite aceptarse o no se recotiza (aceptado, cerrado, con abonos, plan de cuotas o saldo a favor); `REPRICE_INCOMPLETE`: algún propuesto sin precio vigente o sin tasa de hoy (la validez no se renovaría); `REPRICE_NOTHING_TO_APPLY`; `LOCATION_TIMEZONE_REQUIRED`',
  })
  @ApiBadRequestResponse({
    description:
      'El plan no tiene ítems, o el presupuesto no está vencido («El presupuesto no está vencido: acéptalo sin elegir cómo.», como la firma)',
  })
  @ApiForbiddenResponse({
    description:
      'Solo odontólogo y ADMIN aceptan (DX-040); SEC-041: el redondeo sube el % efectivo por encima del tope de quien firma',
  })
  async acceptanceRepricePreview(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<AcceptanceRepricePreviewDto> {
    const { repricing, quote } = await this.previewAcceptanceRepricing.execute(
      patientId,
      planId,
      actorOf(req),
    );
    return { repricing: toPreviewDto(repricing), quote: toDto(quote) };
  }

  // DX-417: la vista previa de aceptar solo una parte del presupuesto. Lee el
  // plan (VIEW) y no escribe nada.
  @Audit({
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'planId' },
    patient: { param: 'patientId' },
    reason: 'ACCEPT_PARTIAL_PREVIEW',
  })
  @Post('acceptance/partial-preview')
  @HttpCode(200)
  @Roles(...TREATMENT_PLAN_DECISION_ROLES)
  @ApiOperation({
    summary:
      'Vista previa de aceptar solo algunos procedimientos del presupuesto (DX-417)',
    description:
      'Compone el presupuesto de lo aceptado como se firmaría (`accepted`, con su `contentHash`), lo que pasaría al presupuesto pendiente (`pending`) y los totales del plan entero (`original`); aceptado + pendiente = original, ítem a ítem. No escribe ni bloquea. Para firmar: POST …/acceptance con `partial.itemIds` (los mismos) y `contentHash` = `accepted.contentHash`. Con un presupuesto vencido que se acepta actualizando los precios, `reprice: true` recotiza TODO el plan (sin escribir) y parte el resultado: `repricing.previewHash` va en `expired.repricePreviewHash`.',
  })
  @ApiOkResponse({ type: PartialAcceptancePreviewDto })
  @ApiBadRequestResponse({
    description:
      'Sin elegir ninguno, eligiendo todos («Has elegido todos los procedimientos: acéptalo entero.»), más de 100, ids que no son UUID, o dejando fuera uno ya aceptado o realizado («Los procedimientos ya aceptados o realizados forman parte de lo aceptado.»). `reprice: true` con un presupuesto no vencido',
  })
  @ApiNotFoundResponse({
    description:
      'Paciente o plan no encontrados en esta clínica (o el plan es de otro paciente), o algún ítem no es de este plan',
  })
  @ApiConflictResponse({
    description:
      '`PARTIAL_PLAN_NOT_PRESENTED` (solo un presupuesto presentado se acepta en parte), `PARTIAL_PLAN_ALREADY_ACCEPTED` (aceptado o firmado), o el plan tiene abonos, plan de cuotas activo o saldo a favor. Con `reprice: true`, los 409 de …/acceptance/reprice-preview (`REPRICE_INCOMPLETE`, `REPRICE_NOTHING_TO_APPLY`, `LOCATION_TIMEZONE_REQUIRED`)',
  })
  @ApiForbiddenResponse({
    description:
      'Solo odontólogo y ADMIN aceptan (DX-040): la asistente y recepción no',
  })
  async partialAcceptancePreview(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: PartialAcceptancePreviewRequestDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PartialAcceptancePreviewDto> {
    const preview = await this.previewPartialAcceptance.execute(
      patientId,
      planId,
      { itemIds: dto.itemIds, reprice: dto.reprice },
      actorOf(req),
    );
    return {
      accepted: toDto(preview.accepted),
      pending: preview.pending,
      original: preview.original,
      repricing: preview.repricing ? toPreviewDto(preview.repricing) : null,
    };
  }
}
