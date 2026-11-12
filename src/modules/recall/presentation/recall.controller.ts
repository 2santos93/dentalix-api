import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { RecallKind } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  APPOINTMENT_ROLES,
  RECALL_INTERVAL_ROLES,
  RECALL_LIST_ROLES,
  RECALL_TYPE_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  CreateRecallTypeUseCase,
  RetireRecallTypeUseCase,
  SetRecallTypeTriggersUseCase,
  UpdateRecallTypeUseCase,
} from '../application/use-cases/recall-types.use-cases';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CreateRecallContactUseCase,
  GetPatientRecallsUseCase,
  ListDueRecallsUseCase,
  ListRecallTypesUseCase,
  SetPatientRecallUseCase,
} from '../application/use-cases/recall.use-cases';
import type {
  PatientRecalls,
  RecallContactView,
  RecallDuePage,
  RecallTypeView,
  SetPatientRecallResult,
} from '../domain/recall.entity';
import {
  CreateRecallContactDto,
  CreateRecallTypeDto,
  PatientRecallsDto,
  RecallContactDto,
  RecallDueCountDto,
  RecallDueCountQueryDto,
  RecallDuePageDto,
  RecallDueQueryDto,
  RecallTypeDto,
  SetPatientRecallDto,
  SetPatientRecallResultDto,
  SetRecallTypeTriggersDto,
  UpdateRecallTypeDto,
} from './dto/recall.dto';

export const RECALL_LIST_FORBIDDEN_MESSAGE =
  'Tu rol no gestiona la lista de recall: es para administración y recepción.';
export const RECALL_INTERVAL_FORBIDDEN_MESSAGE =
  'Solo el personal clínico fija o pausa el recall de un paciente.';
export const RECALL_TYPE_WRITE_FORBIDDEN_MESSAGE =
  'Solo administración gestiona los tipos de recall de la clínica.';

interface AuthenticatedRequest extends AuditableRequest {
  user: TenantJwtPayload;
}

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description:
    'Sede activa: los pacientes cuya sede (la de su última cita atendida o, sin ella, la del recall) es esta; sin ella, las sedes permitidas (vista consolidada)',
};

/**
 * Lista de llamada de recall (DX-015). ADMIN y RECEPTION (403 en español para
 * el resto). Sin PATCH ni DELETE de contactos A PROPÓSITO: son append-only
 * (también en la BD). La auditoría lleva quién y qué, nunca la nota.
 */
@ApiTags('recall')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...RECALL_LIST_ROLES)
@RolesDeniedMessage(RECALL_LIST_FORBIDDEN_MESSAGE)
@Controller('recall')
export class RecallController {
  constructor(
    private readonly listDue: ListDueRecallsUseCase,
    private readonly createContact: CreateRecallContactUseCase,
  ) {}

  // Lista de muchos pacientes con teléfonos: el evento no lleva paciente,
  // pero queda quién la consultó (mismo criterio que pending-follow-up).
  @Audit({ action: 'VIEW', resource: 'PATIENT_RECALL' })
  @Get('due')
  @ApiOperation({
    summary: 'Lista de llamada: pacientes con el control vencido y sin cita',
    description:
      'Recalls activos vencidos (o que vencen en ≤ withinDays) cuyo paciente no tiene cita futura agendada o confirmada ni una en curso, en cualquier sede; sin pausa vigente ni paciente archivado. Vencimiento (guardado) = MAX(último control fijado a mano, último procedimiento disparador del tipo realizado) + intervalo; una cita atendida sin ese procedimiento ya no lo mueve (DX-015-bis). Ordenada por días de vencido.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiOkResponse({ type: RecallDuePageDto })
  @ApiForbiddenResponse({ description: RECALL_LIST_FORBIDDEN_MESSAGE })
  list(@Query() query: RecallDueQueryDto): Promise<RecallDuePage> {
    return this.listDue.execute({
      kind: query.kind,
      recallTypeId: query.recallTypeId,
      withinDays: query.withinDays,
      sort: query.sort,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  // «Mi día» y el menú: solo el número, sin pacientes ni teléfonos, así que no
  // lleva @Audit (mismo criterio que GET /closing-queue/count).
  @Get('due/count')
  @ApiOperation({ summary: 'Cuántos pacientes hay por llamar (recall)' })
  @ApiHeader(LOCATION_HEADER)
  @ApiOkResponse({ type: RecallDueCountDto })
  @ApiForbiddenResponse({ description: RECALL_LIST_FORBIDDEN_MESSAGE })
  async count(
    @Query() query: RecallDueCountQueryDto,
  ): Promise<RecallDueCountDto> {
    const page = await this.listDue.execute({
      kind: query.kind,
      recallTypeId: query.recallTypeId,
      withinDays: query.withinDays,
      page: 1,
      pageSize: 1,
    });
    return { total: page.total };
  }

  @Audit({
    action: 'CREATE',
    resource: 'RECALL_CONTACT',
    resourceId: { response: 'id' },
    patient: { response: 'patientId' },
  })
  @Post(':recallId/contacts')
  @ApiOperation({
    summary: 'Registrar un contacto de recall (append-only)',
    description:
      'Canal, desenlace y una nota corta (≤ 280, sin datos clínicos). «Agendó» (BOOKED) exige la cita creada, del mismo paciente. No se edita ni se borra: una corrección es otro contacto.',
  })
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description:
      'No decide nada: se autoriza y se sella con la sede del paciente (la de la lista), no con la activa.',
  })
  @ApiCreatedResponse({ type: RecallContactDto })
  @ApiBadRequestResponse({
    description:
      'Canal o desenlace inválidos, nota de más de 280, BOOKED sin cita o cita de otro paciente',
  })
  @ApiForbiddenResponse({
    description: `${RECALL_LIST_FORBIDDEN_MESSAGE} O 403 LOCATION_NOT_ALLOWED: el paciente es de una sede no permitida.`,
  })
  @ApiNotFoundResponse({ description: 'Recall de otra clínica o inexistente' })
  contact(
    @Param('recallId', ParseUUIDPipe) recallId: string,
    @Body() dto: CreateRecallContactDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<RecallContactView> {
    return this.createContact.execute(
      recallId,
      {
        channel: dto.channel,
        outcome: dto.outcome,
        note: dto.note,
        appointmentId: dto.appointmentId,
      },
      req.user.sub,
    );
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `:kind` de la ruta: la clave del enum en mayúsculas o minúsculas
 * (compatibilidad, DX-015) o, desde DX-015-bis, el id de un tipo de la clínica.
 */
function parseTypeRef(
  value: string,
): { systemKey: RecallKind } | { id: string } {
  if (UUID_PATTERN.test(value)) return { id: value.toLowerCase() };
  const kind = value.toUpperCase();
  if (kind === RecallKind.HYGIENE || kind === RecallKind.CHECKUP) {
    return { systemKey: kind };
  }
  throw new BadRequestException(
    'El tipo de recall debe ser HYGIENE, CHECKUP o el id de un tipo de la clínica.',
  );
}

/**
 * DX-015-bis: los tipos de recall de la clínica (Higiene, Control,
 * Mantenimiento periodontal y los que añada en Ajustes). Lectura para los
 * cuatro roles que ven la ficha; sin datos de pacientes, así que sin @Audit.
 * Porción 2 (D11–D14): crear, editar, retirar y fijar los disparadores, solo
 * ADMIN (como los tipos de cita); cada escritura deja su evento RECALL_TYPE
 * desde el repositorio, en la transacción del cambio.
 */
@ApiTags('recall')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Controller('recall-types')
export class RecallTypesController {
  constructor(
    private readonly listTypes: ListRecallTypesUseCase,
    private readonly createType: CreateRecallTypeUseCase,
    private readonly updateType: UpdateRecallTypeUseCase,
    private readonly retireType: RetireRecallTypeUseCase,
    private readonly setTriggers: SetRecallTypeTriggersUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Roles(...APPOINTMENT_ROLES)
  @Get()
  @ApiOperation({
    summary: 'Tipos de recall de la clínica',
    description:
      'Vivos (activos o no), por su orden: nombre, intervalo por defecto, activo, orden, clave de compatibilidad (HYGIENE/CHECKUP), grupo de exclusión y los procedimientos del catálogo cuyo DONE mueve su reloj (con su código y su nombre).',
  })
  @ApiOkResponse({ type: [RecallTypeDto] })
  list(): Promise<RecallTypeView[]> {
    return this.listTypes.execute();
  }

  @Post()
  @Roles(...RECALL_TYPE_WRITE_ROLES)
  @RolesDeniedMessage(RECALL_TYPE_WRITE_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary: 'Crear un tipo de recall',
    description:
      'Nombre 1–60 (único entre los vivos sin distinguir mayúsculas), intervalo por defecto 1–36 meses, activo, orden (por defecto, el último) y grupo de exclusión opcional. Sin disparadores: se fijan con PUT /recall-types/:id/triggers.',
  })
  @ApiCreatedResponse({ type: RecallTypeDto })
  @ApiBadRequestResponse({
    description: 'Nombre vacío o largo, intervalo, orden o grupo inválidos',
  })
  @ApiConflictResponse({ description: 'Ya existe un tipo con ese nombre' })
  @ApiForbiddenResponse({ description: RECALL_TYPE_WRITE_FORBIDDEN_MESSAGE })
  create(
    @Body() dto: CreateRecallTypeDto,
    @Req() req: AuditableRequest,
  ): Promise<RecallTypeView> {
    return this.createType.execute(
      {
        name: dto.name,
        defaultIntervalMonths: dto.defaultIntervalMonths,
        active: dto.active,
        sortOrder: dto.sortOrder,
        exclusionGroup: dto.exclusionGroup,
      },
      this.audit(req),
    );
  }

  @Patch(':id')
  @Roles(...RECALL_TYPE_WRITE_ROLES)
  @RolesDeniedMessage(RECALL_TYPE_WRITE_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary: 'Editar un tipo de recall',
    description:
      'Cualquier campo. Cambiar el intervalo por defecto NO cambia los recalls que ya existen: solo los que se creen después. Desactivarlo deja de crear recalls por procedimiento; los que hay siguen. Cambiar el grupo de exclusión no desactiva nada por sí solo: se aplica en el siguiente DONE o PUT del paciente.',
  })
  @ApiOkResponse({ type: RecallTypeDto })
  @ApiBadRequestResponse({ description: 'Campo inválido' })
  @ApiNotFoundResponse({ description: 'Tipo no encontrado en esta clínica' })
  @ApiConflictResponse({ description: 'Ya existe un tipo con ese nombre' })
  @ApiForbiddenResponse({ description: RECALL_TYPE_WRITE_FORBIDDEN_MESSAGE })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRecallTypeDto,
    @Req() req: AuditableRequest,
  ): Promise<RecallTypeView> {
    return this.updateType.execute(
      id,
      {
        name: dto.name,
        defaultIntervalMonths: dto.defaultIntervalMonths,
        active: dto.active,
        sortOrder: dto.sortOrder,
        exclusionGroup: dto.exclusionGroup,
      },
      this.audit(req),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles(...RECALL_TYPE_WRITE_ROLES)
  @RolesDeniedMessage(RECALL_TYPE_WRITE_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary: 'Retirar un tipo de recall (borrado lógico)',
    description:
      'Sus recalls se conservan pero dejan de salir en la lista y en la ficha. Higiene y Control (con clave del enum) no se retiran: se desactivan (409).',
  })
  @ApiNoContentResponse({ description: 'Retirado' })
  @ApiNotFoundResponse({ description: 'Tipo no encontrado en esta clínica' })
  @ApiConflictResponse({
    description: 'Es un tipo del sistema (Higiene, Control): solo se desactiva',
  })
  @ApiForbiddenResponse({ description: RECALL_TYPE_WRITE_FORBIDDEN_MESSAGE })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuditableRequest,
  ): Promise<void> {
    await this.retireType.execute(id, this.audit(req));
  }

  @Put(':id/triggers')
  @Roles(...RECALL_TYPE_WRITE_ROLES)
  @RolesDeniedMessage(RECALL_TYPE_WRITE_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary: 'Fijar los procedimientos que disparan un tipo',
    description:
      'Reemplaza el conjunto. Solo procedimientos vivos del catálogo de la clínica (o los que el tipo ya tenía); uno puede disparar varios tipos.',
  })
  @ApiOkResponse({ type: RecallTypeDto })
  @ApiBadRequestResponse({ description: 'Lista inválida o de más de 50' })
  @ApiNotFoundResponse({ description: 'Tipo no encontrado en esta clínica' })
  @ApiUnprocessableEntityResponse({
    description:
      'Algún id no es un procedimiento vivo del catálogo de esta clínica',
  })
  @ApiForbiddenResponse({ description: RECALL_TYPE_WRITE_FORBIDDEN_MESSAGE })
  triggers(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRecallTypeTriggersDto,
    @Req() req: AuditableRequest,
  ): Promise<RecallTypeView> {
    return this.setTriggers.execute(id, dto.catalogItemIds, this.audit(req));
  }

  /** Quién escribe, para el evento que el repositorio guarda (D14). */
  private audit(req: AuditableRequest) {
    return requireAuditRequestContext(req, this.tenantContext);
  }
}

/**
 * Recall en la ficha del paciente (DX-015): leerlo (los cuatro roles, sin
 * datos clínicos) y fijarlo o pausarlo (CLINICAL_ROLES, con audit_event).
 */
@ApiTags('recall')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Controller('patients/:id/recalls')
export class PatientRecallsController {
  constructor(
    private readonly getRecalls: GetPatientRecallsUseCase,
    private readonly setRecall: SetPatientRecallUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Roles(...APPOINTMENT_ROLES)
  @Audit({
    action: 'VIEW',
    resource: 'PATIENT_RECALL',
    patient: { param: 'id' },
  })
  @Get()
  @ApiOperation({
    summary: 'Recalls del paciente y su historial de contactos',
    description:
      'Cada recall (uno por tipo) con su vencimiento y estado: DUE, UPCOMING, SCHEDULED (ya tiene cita), PAUSED o INACTIVE.',
  })
  @ApiOkResponse({ type: PatientRecallsDto })
  @ApiNotFoundResponse({
    description: 'Paciente de otra clínica o inexistente',
  })
  list(@Param('id', ParseUUIDPipe) patientId: string): Promise<PatientRecalls> {
    return this.getRecalls.execute(patientId);
  }

  @Roles(...RECALL_INTERVAL_ROLES)
  @RolesDeniedMessage(RECALL_INTERVAL_FORBIDDEN_MESSAGE)
  @Audit({
    action: 'UPDATE',
    resource: 'PATIENT_RECALL',
    patient: { param: 'id' },
  })
  @Put(':kind')
  @ApiOperation({
    summary: 'Fijar (o cambiar, pausar, retirar) el recall de un tipo',
    description:
      '«Control cada 6 meses»: intervalo (1–36 meses), día del último control (por defecto hoy en la sede), pausa hasta un día con motivo, o `active: false` para retirarlo. Un recall por paciente y tipo. DX-015-bis: lo fijado queda como `manualDoneAt`; la base es el máximo con el último procedimiento disparador realizado. D9: dar de alta o reactivar el recall de un tipo con grupo de exclusión desactiva los demás recalls activos del paciente de ese grupo (`recallUpdates`).',
  })
  @ApiParam({
    name: 'kind',
    type: String,
    description:
      'HYGIENE o CHECKUP (compatibilidad) o el id de un tipo de la clínica (GET /recall-types)',
  })
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description: 'Sede activa: la del recall nuevo y la de «hoy».',
  })
  @ApiOkResponse({ type: SetPatientRecallResultDto })
  @ApiBadRequestResponse({
    description: 'Intervalo, fechas o motivo inválidos',
  })
  @ApiForbiddenResponse({ description: RECALL_INTERVAL_FORBIDDEN_MESSAGE })
  @ApiNotFoundResponse({
    description:
      'Paciente de otra clínica o inexistente; tipo de recall que no existe en esta clínica',
  })
  set(
    @Param('id', ParseUUIDPipe) patientId: string,
    @Param('kind') kind: string,
    @Body() dto: SetPatientRecallDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<SetPatientRecallResult> {
    return this.setRecall.execute(
      patientId,
      parseTypeRef(kind),
      {
        intervalMonths: dto.intervalMonths,
        lastDoneAt: dto.lastDoneAt,
        active: dto.active,
        disabledUntil: dto.disabledUntil,
        disabledReason: dto.disabledReason,
      },
      req.user.sub,
      // D14: la desactivación por exclusión se audita en la transacción.
      auditRequestContext(req, this.tenantContext),
    );
  }
}
