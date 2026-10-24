import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
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
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CreateTreatmentPlanDto } from './dto/create-treatment-plan.dto';
import { UpdateTreatmentPlanDto } from './dto/update-treatment-plan.dto';
import { AddTreatmentPlanItemDto } from './dto/add-treatment-plan-item.dto';
import { UpdateTreatmentPlanItemDto } from './dto/update-treatment-plan-item.dto';
import { RejectTreatmentPlanDto } from './dto/reject-treatment-plan.dto';
import { CreatePlanAlternativeDto } from './dto/create-plan-alternative.dto';
import {
  ApplyBulkDiscountDto,
  ApplyBulkDiscountResultDto,
} from './dto/apply-bulk-discount.dto';
import { TreatmentPlanDto } from './dto/treatment-plan.dto';
import { TreatmentPlanItemDto } from './dto/treatment-plan-item.dto';
import { CreateTreatmentPlanUseCase } from '../application/use-cases/create-treatment-plan.use-case';
import { ListTreatmentPlansUseCase } from '../application/use-cases/list-treatment-plans.use-case';
import { GetTreatmentPlanUseCase } from '../application/use-cases/get-treatment-plan.use-case';
import { UpdateTreatmentPlanUseCase } from '../application/use-cases/update-treatment-plan.use-case';
import { AddTreatmentPlanItemUseCase } from '../application/use-cases/add-treatment-plan-item.use-case';
import { UpdateTreatmentPlanItemUseCase } from '../application/use-cases/update-treatment-plan-item.use-case';
import { RemoveTreatmentPlanItemUseCase } from '../application/use-cases/remove-treatment-plan-item.use-case';
import { PresentTreatmentPlanUseCase } from '../application/use-cases/present-treatment-plan.use-case';
import { RejectTreatmentPlanUseCase } from '../application/use-cases/reject-treatment-plan.use-case';
import { CreatePlanAlternativeUseCase } from '../application/use-cases/create-plan-alternative.use-case';
import {
  ApplyBulkDiscountUseCase,
  type ApplyBulkDiscountResult,
} from '../application/use-cases/apply-bulk-discount.use-case';
import {
  TreatmentPlan,
  TreatmentPlanDetail,
} from '../domain/entities/treatment-plan.entity';
import { TreatmentPlanItem } from '../domain/entities/treatment-plan-item.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  CLINICAL_ROLES,
  TREATMENT_PLAN_DECISION_ROLES,
  TREATMENT_PLAN_REJECT_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import {
  isTenantPayload,
  JwtPayload,
} from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';

const SIGNED_PLAN_CONFLICT =
  'Plan aceptado con firma: sus ítems quedan congelados (DX-012)';
/** DX-109: además de la firma, un plan cerrado congela sus ítems. */
const ITEMS_LOCKED_CONFLICT = `${SIGNED_PLAN_CONFLICT}; o el plan está cancelado, rechazado o completado (DX-109)`;
/** SEC-050: el ítem de un cargo por inasistencia vigente. */
const FEE_ITEM_CONFLICT =
  'SEC-050: el ítem es el cargo vigente por inasistencia o cancelación tardía de una cita (`cancellationFeeAppointmentId`): su precio, descuento y estado no cambian ni se quita, sea cual sea el rol; se anula con POST /appointments/{id}/cancellation-fee/void';
/** DX-204: un presupuesto aceptado (con o sin firma) no se vuelve a descontar. */
const DISCOUNT_LOCKED_CONFLICT = `${ITEMS_LOCKED_CONFLICT}; o el descuento (también una rebaja del precio frente al de catálogo) cambia en un plan ya aceptado (DX-204, SEC-041). El estado del plan se comprueba con su fila bloqueada, dentro de la transacción (BE-036)`;
const DISCOUNT_FORBIDDEN =
  'DX-204: el descuento EFECTIVO (SEC-041: rebaja del precio frente al de catálogo + descuento) supera el tope del rol de quien lo da («Tu rol permite hasta un X % de descuento por ítem.»; con rebaja de precio, precedido de «Precio por debajo del de catálogo: cuenta como descuento.»). Subir el precio es libre';
const DISCOUNT_UNPROCESSABLE =
  'DX-204: por encima del umbral de la política falta el motivo (con rebaja de precio: «… Indica el motivo del descuento.»), o «Otro» sin nota, o nota sin motivo';

interface AuthenticatedRequest extends AuditableRequest {
  user: JwtPayload;
}

const TRANSITION_CONFLICT =
  'Transición de estado no permitida por la máquina de estados (DX-040: DRAFT → PRESENTED → ACCEPTED | REJECTED; DRAFT → ACCEPTED; ACCEPTED → COMPLETED; cualquiera salvo COMPLETED → CANCELLED)';

/** El rol de quien llama, del token (TenantContextInterceptor ya exige uno de clínica). */
function actorRole(req: AuthenticatedRequest) {
  if (!isTenantPayload(req.user)) {
    throw new ForbiddenException('Insufficient role');
  }
  return { role: req.user.role, userId: req.user.sub };
}

// Plan de tratamiento es dato CLÍNICO -> @Roles(...CLINICAL_ROLES) (DENTIST/
// ASSISTANT/ADMIN, NO recepción — ver docs/plans/2026-07-24-treatment-plans.md
// "Global Constraints"). No `@Controller(prefix)` base: routes mix a
// patient-nested path (`patients/:patientId/treatment-plans`) with top-level
// paths keyed by plan/item id (`treatment-plans/:id[/items/:itemId]`), so each
// method declares its own full path (same rationale as
// AppointmentsController mixing bare `/appointments` — here it's two
// different prefixes instead of one, so a single class-level prefix can't
// cover both).
@ApiTags('treatment-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@Controller()
export class TreatmentPlansController {
  constructor(
    private readonly createTreatmentPlan: CreateTreatmentPlanUseCase,
    private readonly listTreatmentPlans: ListTreatmentPlansUseCase,
    private readonly getTreatmentPlan: GetTreatmentPlanUseCase,
    private readonly updateTreatmentPlan: UpdateTreatmentPlanUseCase,
    private readonly addTreatmentPlanItem: AddTreatmentPlanItemUseCase,
    private readonly updateTreatmentPlanItem: UpdateTreatmentPlanItemUseCase,
    private readonly removeTreatmentPlanItem: RemoveTreatmentPlanItemUseCase,
    private readonly presentTreatmentPlan: PresentTreatmentPlanUseCase,
    private readonly rejectTreatmentPlan: RejectTreatmentPlanUseCase,
    private readonly createPlanAlternative: CreatePlanAlternativeUseCase,
    private readonly applyBulkDiscount: ApplyBulkDiscountUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Audit({
    action: 'CREATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
  })
  @Post('patients/:patientId/treatment-plans')
  @ApiParam({ name: 'patientId', format: 'uuid' })
  @ApiCreatedResponse({ type: TreatmentPlanDto })
  @ApiNotFoundResponse({
    description:
      'Paciente no encontrado en esta clínica (inexistente o de otra clínica).',
  })
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateTreatmentPlanDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<TreatmentPlan> {
    // `createdById` comes from the authenticated user (req.user.sub), never
    // from the client body — same convention as AppointmentsController.create
    // / OdontogramController.create.
    return this.createTreatmentPlan.execute({
      patientId,
      currency: dto.currency,
      notes: dto.notes,
      createdById: req.user.sub,
    });
  }

  @Audit({
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    patient: { param: 'patientId' },
  })
  @Get('patients/:patientId/treatment-plans')
  @ApiParam({ name: 'patientId', format: 'uuid' })
  @ApiOkResponse({ type: [TreatmentPlanDto] })
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<TreatmentPlan[]> {
    return this.listTreatmentPlans.execute(patientId);
  }

  @Audit({
    action: 'VIEW',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
  })
  @Get('treatment-plans/:id')
  @ApiOkResponse({ type: TreatmentPlanDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<TreatmentPlanDetail> {
    return this.getTreatmentPlan.execute(id);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
  })
  @Patch('treatment-plans/:id')
  @ApiOkResponse({ type: TreatmentPlanDto })
  @ApiBadRequestResponse({
    description:
      'Moneda desconocida, o status PRESENTED/REJECTED (tienen su propia acción)',
  })
  @ApiForbiddenResponse({
    description:
      'status ACCEPTED: solo DENTIST y ADMIN (la asistente no acepta en nombre del doctor)',
  })
  @ApiConflictResponse({
    description: `${TRANSITION_CONFLICT}; plan aceptado con firma: no cambia de moneda ni vuelve atrás (DX-012); otra opción del grupo ya aceptada; la moneda no cambia si el plan tiene abonos vivos, un plan de cuotas activo o está cerrado (DX-109). SEC-050: el plan que lleva un cargo vigente por inasistencia no se cancela ni cambia de moneda (completarlo sí). Aceptar pasa los ítems propuestos a aceptados, igual que la aceptación firmada, y cancela el plan de cuotas activo de las hermanas que rechaza; cancelar cancela también el plan de cuotas activo`,
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTreatmentPlanDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<TreatmentPlan> {
    return this.updateTreatmentPlan.execute(
      id,
      {
        status: dto.status,
        currency: dto.currency,
        notes: dto.notes,
        optionLabel: dto.optionLabel,
      },
      actorRole(req),
    );
  }

  // --- Alternativas, presentación y rechazo (DX-040) -----------------------

  @Audit({
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
  })
  @Post('treatment-plans/:id/present')
  @HttpCode(200)
  @Roles(...TREATMENT_PLAN_DECISION_ROLES)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description:
      'Sede donde se presenta; sin ella, la principal. La lista de presupuestos por seguir filtra por esta sede',
  })
  @ApiOkResponse({
    type: TreatmentPlanDto,
    description: 'Plan PRESENTED, con presentedAt (servidor) y la sede',
  })
  @ApiBadRequestResponse({ description: 'El plan no tiene ítems' })
  @ApiForbiddenResponse({ description: 'Solo DENTIST y ADMIN presentan' })
  @ApiNotFoundResponse({ description: 'Plan no encontrado en esta clínica' })
  @ApiConflictResponse({
    description: `${TRANSITION_CONFLICT}: solo se presenta un borrador`,
  })
  present(@Param('id', ParseUUIDPipe) id: string): Promise<TreatmentPlan> {
    return this.presentTreatmentPlan.execute(id);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
  })
  @Post('treatment-plans/:id/reject')
  @HttpCode(200)
  @Roles(...TREATMENT_PLAN_REJECT_ROLES)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({
    type: TreatmentPlanDto,
    description:
      'Plan REJECTED con motivo, nota y rejectedAt (servidor); las demás opciones del grupo no cambian. Su plan de cuotas activo, si lo tiene, se cancela en la misma transacción con autor y motivo (DX-109)',
  })
  @ApiBadRequestResponse({
    description:
      'Sin motivo, motivo fuera del catálogo, OTHER_OPTION_ACCEPTED (lo pone el sistema) u OTHER sin nota',
  })
  @ApiForbiddenResponse({
    description: 'DENTIST, ADMIN y RECEPTION rechazan; la asistente no',
  })
  @ApiNotFoundResponse({ description: 'Plan no encontrado en esta clínica' })
  @ApiConflictResponse({
    description: `${TRANSITION_CONFLICT}: solo se rechaza un plan presentado`,
  })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectTreatmentPlanDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<TreatmentPlan> {
    return this.rejectTreatmentPlan.execute(
      id,
      { reason: dto.reason, note: dto.note },
      actorRole(req).userId,
    );
  }

  @Audit({
    action: 'CREATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { response: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
  })
  @Post('treatment-plans/:id/alternatives')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({
    type: TreatmentPlanDto,
    description:
      'Alternativa nueva en DRAFT: mismo paciente y moneda, copia de los ítems vivos, en el grupo del plan de origen (que, si era suelto, pasa a «Opción A»)',
  })
  @ApiNotFoundResponse({ description: 'Plan no encontrado en esta clínica' })
  @ApiConflictResponse({
    description: 'Una opción del grupo ya está aceptada o completada',
  })
  createAlternative(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePlanAlternativeDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<TreatmentPlan> {
    return this.createPlanAlternative.execute(id, {
      optionLabel: dto.optionLabel,
      createdById: req.user.sub,
    });
  }

  @Audit({
    action: 'CREATE',
    resource: 'TREATMENT_PLAN_ITEM',
    resourceId: { response: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
  })
  @Post('treatment-plans/:id/items')
  @ApiCreatedResponse({ type: TreatmentPlanItemDto })
  @ApiForbiddenResponse({ description: DISCOUNT_FORBIDDEN })
  @ApiConflictResponse({ description: DISCOUNT_LOCKED_CONFLICT })
  @ApiUnprocessableEntityResponse({ description: DISCOUNT_UNPROCESSABLE })
  addItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTreatmentPlanItemDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<TreatmentPlanItem> {
    return this.addTreatmentPlanItem.execute(
      id,
      {
        toothNumber: dto.toothNumber,
        surfaces: dto.surfaces,
        catalogItemId: dto.catalogItemId,
        price: dto.price,
        discount: dto.discount,
        discountReason: dto.discountReason,
        discountReasonNote: dto.discountReasonNote,
        notes: dto.notes,
      },
      actorRole(req),
    );
  }

  // Un solo evento por petición (DX-009): UPDATE de TREATMENT_PLAN_ITEM con
  // `reason` BULK_DISCOUNT y los NOMBRES de los campos; ni importes ni la nota.
  @Audit({
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN_ITEM',
    patient: { lookup: 'treatmentPlan', param: 'id' },
    reason: 'BULK_DISCOUNT',
  })
  @Post('treatment-plans/:id/items/bulk-discount')
  @HttpCode(200)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description: 'Sede donde se da el descuento; sin ella, la principal',
  })
  @ApiOkResponse({
    type: ApplyBulkDiscountResultDto,
    description:
      'Los ítems con su descuento nuevo y cuántos se saltaron por no admitir descuentos (DX-105)',
  })
  @ApiNotFoundResponse({
    description: 'Plan, o algún ítem, inexistente o de otro plan: nada cambia',
  })
  @ApiForbiddenResponse({ description: DISCOUNT_FORBIDDEN })
  @ApiConflictResponse({ description: DISCOUNT_LOCKED_CONFLICT })
  @ApiUnprocessableEntityResponse({ description: DISCOUNT_UNPROCESSABLE })
  bulkDiscount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyBulkDiscountDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApplyBulkDiscountResult> {
    return this.applyBulkDiscount.execute(
      id,
      {
        itemIds: dto.itemIds,
        percent: dto.percent,
        discountReason: dto.discountReason,
        discountReasonNote: dto.discountReasonNote,
      },
      actorRole(req),
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN_ITEM',
    resourceId: { param: 'itemId' },
    patient: { lookup: 'treatmentPlanItem', param: 'itemId' },
  })
  @Patch('treatment-plans/:id/items/:itemId')
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description:
      'DX-050: sede donde se realizó al pasar a DONE; sin ella, la de escritura de la sesión (la principal o la primera permitida)',
  })
  @ApiOkResponse({ type: TreatmentPlanItemDto })
  @ApiBadRequestResponse({
    description:
      'DX-050: pasar a DONE sin `performedById` quien no atiende (ASSISTANT); el profesional no atiende (ASSISTANT/RECEPTION) o no atiende en la sede; `completedAt` al pasar a DONE o futuro; `performedById`/`completedAt` en un ítem que no queda DONE. Mensaje en español',
  })
  @ApiNotFoundResponse({
    description:
      'Ítem inexistente o de otra clínica; DX-050: `performedById` que no es miembro activo de esta clínica (otra clínica o desactivado)',
  })
  @ApiForbiddenResponse({
    description: `${DISCOUNT_FORBIDDEN}. DX-050: cambiar quién o cuándo de un ítem DONE (solo ADMIN); sacarlo de DONE (solo ADMIN o quien lo realizó)`,
  })
  @ApiConflictResponse({
    description: `${DISCOUNT_LOCKED_CONFLICT}; ${FEE_ITEM_CONFLICT}; firmado: solo admite avanzar el estado (no volver a PROPOSED); completado: solo admite marcar como DONE un ítem ACCEPTED sin otro cambio; cerrado: DX-050 admite además corregir quién, cuándo o dónde (DX-305) de un ítem DONE, sin otro cambio`,
  })
  @ApiUnprocessableEntityResponse({ description: DISCOUNT_UNPROCESSABLE })
  updateItem(
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateTreatmentPlanItemDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<TreatmentPlanItem> {
    // El actor (token, nunca el body) decide el tope del descuento (DX-204)
    // y, si atiende, es por defecto quien realizó el ítem (DX-050), que firma
    // el registro del odontograma (Pieza B).
    return this.updateTreatmentPlanItem.execute(
      itemId,
      {
        price: dto.price,
        discount: dto.discount,
        discountReason: dto.discountReason,
        discountReasonNote: dto.discountReasonNote,
        status: dto.status,
        surfaces: dto.surfaces,
        notes: dto.notes,
        performedById: dto.performedById,
        completedAt:
          dto.completedAt === undefined ? undefined : new Date(dto.completedAt),
        performedLocationId: dto.performedLocationId,
      },
      actorRole(req),
      auditRequestContext(req, this.tenantContext),
    );
  }

  @Audit({
    action: 'DELETE',
    resource: 'TREATMENT_PLAN_ITEM',
    resourceId: { param: 'itemId' },
    patient: { lookup: 'treatmentPlanItem', param: 'itemId' },
  })
  @Delete('treatment-plans/:id/items/:itemId')
  @ApiOkResponse({ description: 'Item soft-deleted (deletedAt set)' })
  @ApiConflictResponse({
    description: `${ITEMS_LOCKED_CONFLICT}; ${FEE_ITEM_CONFLICT}`,
  })
  removeItem(@Param('itemId', ParseUUIDPipe) itemId: string): Promise<void> {
    return this.removeTreatmentPlanItem.execute(itemId);
  }
}
