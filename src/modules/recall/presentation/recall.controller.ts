import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
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
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CreateRecallContactUseCase,
  GetPatientRecallsUseCase,
  ListDueRecallsUseCase,
  SetPatientRecallUseCase,
} from '../application/use-cases/recall.use-cases';
import type {
  PatientRecalls,
  RecallContactView,
  RecallDuePage,
} from '../domain/recall.entity';
import {
  CreateRecallContactDto,
  PatientRecallsDto,
  RecallContactDto,
  RecallDueCountDto,
  RecallDueCountQueryDto,
  RecallDuePageDto,
  RecallDueQueryDto,
  SetPatientRecallDto,
} from './dto/recall.dto';

export const RECALL_LIST_FORBIDDEN_MESSAGE =
  'Tu rol no gestiona la lista de recall: es para administración y recepción.';
export const RECALL_INTERVAL_FORBIDDEN_MESSAGE =
  'Solo el personal clínico fija o pausa el recall de un paciente.';

interface AuthenticatedRequest {
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
      'Recalls activos vencidos (o que vencen en ≤ withinDays) cuyo paciente no tiene cita futura agendada o confirmada ni una en curso, en cualquier sede; sin pausa vigente ni paciente archivado. Vencimiento = MAX(último control fijado, última cita atendida) + intervalo. Ordenada por días de vencido.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiOkResponse({ type: RecallDuePageDto })
  @ApiForbiddenResponse({ description: RECALL_LIST_FORBIDDEN_MESSAGE })
  list(@Query() query: RecallDueQueryDto): Promise<RecallDuePage> {
    return this.listDue.execute({
      kind: query.kind,
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
    description: 'Sede activa: queda en el contacto.',
  })
  @ApiCreatedResponse({ type: RecallContactDto })
  @ApiBadRequestResponse({
    description:
      'Canal o desenlace inválidos, nota de más de 280, BOOKED sin cita o cita de otro paciente',
  })
  @ApiForbiddenResponse({ description: RECALL_LIST_FORBIDDEN_MESSAGE })
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

/** `:kind` de la ruta, en mayúsculas o minúsculas. */
function parseKind(value: string): RecallKind {
  const kind = value.toUpperCase();
  if (kind === RecallKind.HYGIENE || kind === RecallKind.CHECKUP) return kind;
  throw new BadRequestException(
    'El tipo de recall debe ser HYGIENE o CHECKUP.',
  );
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
      '«Control cada 6 meses»: intervalo (1–36 meses), día del último control (por defecto hoy en la sede), pausa hasta un día con motivo, o `active: false` para retirarlo. Un recall por paciente y tipo.',
  })
  @ApiParam({ name: 'kind', enum: RecallKind, enumName: 'RecallKind' })
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description: 'Sede activa: la del recall nuevo y la de «hoy».',
  })
  @ApiOkResponse({ type: PatientRecallsDto })
  @ApiBadRequestResponse({
    description: 'Intervalo, fechas o motivo inválidos',
  })
  @ApiForbiddenResponse({ description: RECALL_INTERVAL_FORBIDDEN_MESSAGE })
  @ApiNotFoundResponse({
    description: 'Paciente de otra clínica o inexistente',
  })
  set(
    @Param('id', ParseUUIDPipe) patientId: string,
    @Param('kind') kind: string,
    @Body() dto: SetPatientRecallDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PatientRecalls> {
    return this.setRecall.execute(
      patientId,
      parseKind(kind),
      {
        intervalMonths: dto.intervalMonths,
        lastDoneAt: dto.lastDoneAt,
        active: dto.active,
        disabledUntil: dto.disabledUntil,
        disabledReason: dto.disabledReason,
      },
      req.user.sub,
    );
  }
}
