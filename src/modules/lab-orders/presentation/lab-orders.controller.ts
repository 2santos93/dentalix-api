import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  LAB_ORDER_CHECK_ROLES,
  LAB_ORDER_COST_ROLES,
  LAB_ORDER_PATCH_ROLES,
  LAB_ORDER_PRINT_ROLES,
  LAB_ORDER_READ_ROLES,
  LAB_ORDER_RECEIVE_ROLES,
  LAB_ORDER_SEND_ROLES,
  LAB_ORDER_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { LabOrderUseCases } from '../application/lab-orders.use-cases';
import type {
  DueDateSuggestion,
  LabOrderPage,
  LabOrderPrintView,
  LabOrderView,
} from '../domain/entities';
import {
  CancelLabOrderDto,
  CreateLabOrderDto,
  DueDateSuggestionDto,
  DueDateSuggestionQueryDto,
  LabOrderDto,
  LabOrderPageDto,
  LabOrderPrintDto,
  LabOrdersQueryDto,
  PatientLabOrdersQueryDto,
  SendLabOrderDto,
  SetLabOrderCostDto,
  UpdateLabOrderDto,
} from './dto/lab-order.dto';

interface AuthenticatedRequest extends AuditableRequest {
  user: TenantJwtPayload;
}

export const LAB_ORDER_WRITE_FORBIDDEN_MESSAGE =
  'Solo el odontólogo o la administración crean, cambian y anulan órdenes de laboratorio.';
export const LAB_ORDER_PATCH_FORBIDDEN_MESSAGE =
  'Tu rol no cambia órdenes de laboratorio: recepción solo la fecha prometida y la cita; el contenido, el odontólogo.';
export const LAB_ORDER_STEP_FORBIDDEN_MESSAGE =
  'Envían y reciben trabajos de laboratorio el odontólogo, recepción y la administración.';
export const LAB_ORDER_CHECK_FORBIDDEN_MESSAGE =
  'Solo el odontólogo o la administración marcan un trabajo de laboratorio como revisado.';
export const LAB_ORDER_COST_FORBIDDEN_MESSAGE =
  'Solo la administración pone el costo del laboratorio.';
export const LAB_ORDER_PRINT_FORBIDDEN_MESSAGE =
  'La orden impresa lleva datos clínicos: la imprimen los roles clínicos.';

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description:
    'Sede activa. Sin ella, la sede principal (o la primera permitida).',
};

/** Órdenes de laboratorio del paciente (DX-017). */
@ApiTags('lab-orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...LAB_ORDER_READ_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId/lab-orders')
export class PatientLabOrdersController {
  constructor(
    private readonly orders: LabOrderUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Audit({
    action: 'VIEW',
    resource: 'DENTAL_LAB_ORDER',
    patient: { param: 'patientId' },
  })
  @Get()
  @ApiOperation({
    summary: 'Órdenes de laboratorio del paciente, la más reciente primero',
  })
  @ApiOkResponse({ type: LabOrderPageDto })
  @ApiBadRequestResponse({ description: 'Página fuera de rango' })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query() query: PatientLabOrdersQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<LabOrderPage> {
    return this.orders.listForPatient(
      patientId,
      { page: query.page, pageSize: query.pageSize },
      req.user.role,
    );
  }

  @Audit({
    action: 'CREATE',
    resource: 'DENTAL_LAB_ORDER',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
  })
  @Post()
  @Roles(...LAB_ORDER_WRITE_ROLES)
  @RolesDeniedMessage(LAB_ORDER_WRITE_FORBIDDEN_MESSAGE)
  @ApiHeader(LOCATION_HEADER)
  @ApiOperation({
    summary: 'Crea una orden de laboratorio en borrador',
    description:
      'El profesional es quien la crea. Sin dueOn y con servicio, la fecha prometida sugerida desde hoy en días hábiles de la sede.',
  })
  @ApiCreatedResponse({ type: LabOrderDto })
  @ApiBadRequestResponse({
    description: 'Descripción, dientes FDI, textos o fecha fuera de rango',
  })
  @ApiNotFoundResponse({
    description:
      'Paciente, sede, laboratorio o servicio no encontrados en esta clínica',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Ítem del plan, cita u orden corregida de otro paciente; laboratorio o servicio inactivo; servicio de otro laboratorio',
  })
  @ApiForbiddenResponse({ description: LAB_ORDER_WRITE_FORBIDDEN_MESSAGE })
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateLabOrderDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<LabOrderView> {
    return this.orders.create(
      patientId,
      {
        labId: dto.labId,
        serviceId: dto.serviceId,
        description: dto.description,
        toothNumbers: dto.toothNumbers,
        shade: dto.shade,
        material: dto.material,
        instructions: dto.instructions,
        dueOn: dto.dueOn,
        treatmentPlanItemId: dto.treatmentPlanItemId,
        appointmentId: dto.appointmentId,
        replacesOrderId: dto.replacesOrderId,
        locationId: dto.locationId,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}

/** Órdenes de laboratorio por id y la lista de la sede (DX-017). */
@ApiTags('lab-orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...LAB_ORDER_READ_ROLES)
@Controller('lab-orders')
export class LabOrdersController {
  constructor(
    private readonly orders: LabOrderUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  // Lista de muchos pacientes: el evento no lleva paciente (como la de recall).
  @Audit({
    action: 'VIEW',
    resource: 'DENTAL_LAB_ORDER',
    reason: 'DENTAL_LAB_ORDER_LIST',
  })
  @Get()
  @ApiHeader(LOCATION_HEADER)
  @ApiOperation({
    summary: 'Trabajos de laboratorio de una sede, con filtros',
    description:
      'Una sede: la pedida o la activa (respeta las sedes del miembro). Orden: atrasadas primero, luego fecha prometida (sin fecha al final) y luego el número más alto. from/to filtran por la fecha prometida.',
  })
  @ApiOkResponse({ type: LabOrderPageDto })
  @ApiBadRequestResponse({ description: 'Filtro, fecha o página inválidos' })
  @ApiNotFoundResponse({ description: 'Sede no encontrada en esta clínica' })
  @ApiForbiddenResponse({
    description: '403 LOCATION_NOT_ALLOWED: sede no permitida al miembro',
  })
  list(
    @Query() query: LabOrdersQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<LabOrderPage> {
    return this.orders.list(
      {
        locationId: query.locationId,
        statuses: query.status,
        labId: query.labId,
        from: query.from,
        to: query.to,
        overdue: query.overdue,
        page: query.page,
        pageSize: query.pageSize,
      },
      req.user.role,
    );
  }

  @Get('due-date-suggestion')
  @ApiHeader(LOCATION_HEADER)
  @ApiOperation({
    summary: 'Fecha prometida sugerida para un servicio',
    description:
      'Día de inicio + plazo del servicio en días hábiles de la sede (calendario y festivos DX-316, solo los días con horario).',
  })
  @ApiOkResponse({ type: DueDateSuggestionDto })
  @ApiBadRequestResponse({ description: 'Ids o fecha inválidos' })
  @ApiNotFoundResponse({ description: 'Sede o servicio no encontrados' })
  suggestDueDate(
    @Query() query: DueDateSuggestionQueryDto,
  ): Promise<DueDateSuggestion> {
    return this.orders.suggestDueDate({
      locationId: query.locationId,
      serviceId: query.serviceId,
      from: query.from,
    });
  }

  @Audit({
    action: 'VIEW',
    resource: 'DENTAL_LAB_ORDER',
    resourceId: { param: 'id' },
    patient: { response: 'patientId' },
  })
  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Una orden de laboratorio' })
  @ApiOkResponse({ type: LabOrderDto })
  @ApiNotFoundResponse({ description: 'Orden de otra clínica o inexistente' })
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<LabOrderView> {
    return this.orders.get(id, req.user.role);
  }

  // Auditado en el caso de uso (UPDATE con los campos y la fecha prometida).
  @Patch(':id')
  @Roles(...LAB_ORDER_PATCH_ROLES)
  @RolesDeniedMessage(LAB_ORDER_PATCH_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Cambia datos y vínculos de la orden (null borra un opcional)',
    description:
      'En borrador, todo. Tras «Enviada» solo dueOn y appointmentId (409 para el resto: se corrige con una orden nueva que la sustituya). Recepción solo dueOn y appointmentId.',
  })
  @ApiOkResponse({ type: LabOrderDto })
  @ApiBadRequestResponse({ description: 'Campos fuera de rango o sin cambios' })
  @ApiNotFoundResponse({
    description: 'Orden, laboratorio o servicio de otra clínica o inexistente',
  })
  @ApiConflictResponse({
    description: 'Orden anulada, ya enviada o cambiada a la vez',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Ítem, cita u orden corregida de otro paciente; laboratorio o servicio inactivo',
  })
  @ApiForbiddenResponse({ description: LAB_ORDER_PATCH_FORBIDDEN_MESSAGE })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLabOrderDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<LabOrderView> {
    return this.orders.update(
      id,
      {
        labId: dto.labId,
        serviceId: dto.serviceId,
        description: dto.description,
        toothNumbers: dto.toothNumbers,
        shade: dto.shade,
        material: dto.material,
        instructions: dto.instructions,
        dueOn: dto.dueOn,
        treatmentPlanItemId: dto.treatmentPlanItemId,
        appointmentId: dto.appointmentId,
        replacesOrderId: dto.replacesOrderId,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  // DX-018-bis: auditado en el caso de uso (UPDATE DENTAL_LAB_ORDER_COST_UPDATED,
  // importe y moneda antes y después).
  @Put(':id/cost')
  @Roles(...LAB_ORDER_COST_ROLES)
  @RolesDeniedMessage(LAB_ORDER_COST_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Pone o quita el costo del laboratorio de la orden (solo ADMIN)',
    description:
      'En cualquier estado salvo anulada (también tras «Enviada»: el laboratorio factura al entregar). Con «descontar laboratorio» en la regla de honorarios, el costo en la moneda del plan del ítem se descuenta de la base; en otra moneda no se convierte: se avisa y no se descuenta.',
  })
  @ApiOkResponse({ type: LabOrderDto })
  @ApiBadRequestResponse({
    description: 'Costo o moneda inválidos, uno sin el otro, o sin cambios',
  })
  @ApiNotFoundResponse({ description: 'Orden de otra clínica o inexistente' })
  @ApiConflictResponse({ description: 'Orden anulada o cambiada a la vez' })
  @ApiUnprocessableEntityResponse({ description: 'La moneda no existe' })
  @ApiForbiddenResponse({ description: LAB_ORDER_COST_FORBIDDEN_MESSAGE })
  setCost(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetLabOrderCostDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<LabOrderView> {
    return this.orders.setCost(
      id,
      { cost: dto.cost, currency: dto.currency },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  // Auditado en el caso de uso (UPDATE DENTAL_LAB_ORDER_SENT, DRAFT → SENT).
  @Post(':id/send')
  @HttpCode(200)
  @Roles(...LAB_ORDER_SEND_ROLES)
  @RolesDeniedMessage(LAB_ORDER_STEP_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Marca la orden como enviada (desde aquí el contenido no cambia)',
  })
  @ApiOkResponse({ type: LabOrderDto })
  @ApiNotFoundResponse({ description: 'Orden de otra clínica o inexistente' })
  @ApiConflictResponse({ description: 'Ya enviada o anulada' })
  @ApiForbiddenResponse({ description: LAB_ORDER_STEP_FORBIDDEN_MESSAGE })
  send(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendLabOrderDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<LabOrderView> {
    return this.orders.send(
      id,
      { dueOn: dto.dueOn },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  // Auditado en el caso de uso (UPDATE DENTAL_LAB_ORDER_RECEIVED).
  @Post(':id/receive')
  @HttpCode(200)
  @Roles(...LAB_ORDER_RECEIVE_ROLES)
  @RolesDeniedMessage(LAB_ORDER_STEP_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Marca el trabajo como recibido (fecha y quién)' })
  @ApiOkResponse({ type: LabOrderDto })
  @ApiNotFoundResponse({ description: 'Orden de otra clínica o inexistente' })
  @ApiUnprocessableEntityResponse({
    description: 'No se puede recibir una orden que no se ha enviado',
  })
  @ApiConflictResponse({ description: 'Ya recibida o anulada' })
  @ApiForbiddenResponse({ description: LAB_ORDER_STEP_FORBIDDEN_MESSAGE })
  receive(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<LabOrderView> {
    return this.orders.receive(
      id,
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  // Auditado en el caso de uso (UPDATE DENTAL_LAB_ORDER_CHECKED).
  @Post(':id/check')
  @HttpCode(200)
  @Roles(...LAB_ORDER_CHECK_ROLES)
  @RolesDeniedMessage(LAB_ORDER_CHECK_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Marca el trabajo como revisado' })
  @ApiOkResponse({ type: LabOrderDto })
  @ApiNotFoundResponse({ description: 'Orden de otra clínica o inexistente' })
  @ApiUnprocessableEntityResponse({
    description: 'No se puede revisar una orden que no se ha recibido',
  })
  @ApiConflictResponse({ description: 'Ya revisada o anulada' })
  @ApiForbiddenResponse({ description: LAB_ORDER_CHECK_FORBIDDEN_MESSAGE })
  check(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<LabOrderView> {
    return this.orders.check(
      id,
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  // Auditado en el caso de uso (VOID DENTAL_LAB_ORDER_CANCELLED, sin el motivo).
  @Post(':id/cancel')
  @HttpCode(200)
  @Roles(...LAB_ORDER_WRITE_ROLES)
  @RolesDeniedMessage(LAB_ORDER_WRITE_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary:
      'Anula la orden con motivo (nunca se borra; una revisada no se anula)',
  })
  @ApiOkResponse({ type: LabOrderDto })
  @ApiBadRequestResponse({
    description: 'Motivo de menos de 3 o más de 500 caracteres',
  })
  @ApiNotFoundResponse({ description: 'Orden de otra clínica o inexistente' })
  @ApiConflictResponse({ description: 'Ya anulada o revisada' })
  @ApiForbiddenResponse({ description: LAB_ORDER_WRITE_FORBIDDEN_MESSAGE })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelLabOrderDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<LabOrderView> {
    return this.orders.cancel(
      id,
      { reason: dto.reason },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  // Auditado en el caso de uso (PRINT DENTAL_LAB_ORDER_PRINTED).
  @Get(':id/print')
  @Roles(...LAB_ORDER_PRINT_ROLES)
  @RolesDeniedMessage(LAB_ORDER_PRINT_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'La orden como prescripción imprimible (A4)',
    description:
      'Datos de la clínica y la sede, el profesional con su nº de registro y especialidad, el paciente y la orden completa.',
  })
  @ApiOkResponse({ type: LabOrderPrintDto })
  @ApiNotFoundResponse({ description: 'Orden de otra clínica o inexistente' })
  @ApiForbiddenResponse({ description: LAB_ORDER_PRINT_FORBIDDEN_MESSAGE })
  print(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<LabOrderPrintView> {
    return this.orders.print(
      id,
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}
