import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
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
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { APPOINTMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { requireAuditRequestContext } from '../../audit/presentation/audit-request-context';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import type { JwtPayload } from '../../../shared/crypto/token.service';
import {
  AppointmentSeriesUseCase,
  type CreatedSeries,
  type SeriesChangeResult,
  type SeriesPreview,
} from '../application/use-cases/appointment-series.use-case';
import {
  AppointmentSeriesChangeDto,
  AppointmentSeriesConflictDto,
  AppointmentSeriesPreviewDto,
  CancelAppointmentSeriesDto,
  CreateAppointmentSeriesDto,
  CreatedAppointmentSeriesDto,
  MoveAppointmentSeriesDto,
  PreviewAppointmentSeriesDto,
} from './dto/appointment-series.dto';

interface AuthenticatedRequest {
  user: JwtPayload;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

const CONFLICT_DESCRIPTION =
  '`code: APPOINTMENT_SERIES_CONFLICT`: alguna fecha ya no se puede agendar (revisada otra vez en el servidor, o la BD resolvió una carrera). `conflicts` trae TODAS las que chocan, con su posición y sus razones (mismos códigos que la vista previa); no se escribió nada: vuelve a la vista previa. `conflicts` vacío = otra escritura a la vez no dejó terminar (reintentar).';

/**
 * DX-562: citas en serie («cada N semanas, N veces o hasta una fecha»). Mismos
 * roles que agendar (los 5, recepción incluida); cancelar y mover aplican
 * además, por cita, las reglas y permisos de cancelarla o moverla suelta.
 * Auditadas en el caso de uso: UN `audit_event` por operación, en su
 * transacción. Un balde de rate limit por clínica + usuario para todas.
 */
@ApiTags('appointments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@RateLimit('appointment-series')
@Controller('appointments/series')
export class AppointmentSeriesController {
  constructor(
    private readonly series: AppointmentSeriesUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: AppointmentSeriesPreviewDto,
    description:
      'D3: las fechas de la serie (la base primero) con la misma hora de pared en la zona de la sede y la misma duración, y si cada una se puede agendar: `OK`, o `CONFLICT` con TODAS sus razones (código estable y el texto de la cita suelta) y la alternativa del mismo día. No escribe nada. Sede: la de X-Location-Id (o la de escritura de la sesión).',
  })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (como al agendar), intervalo fuera de 1–12, sin `count` ni `until` (o los dos), `count` fuera de 2–26, `until` inválido, anterior a la base, a más de un año o con más de 26 citas, o la cita base en el pasado',
  })
  @ApiForbiddenResponse({ description: 'Sede no permitida al usuario' })
  @ApiNotFoundResponse({
    description: 'Paciente, profesional o sillón de otra clínica',
  })
  preview(
    @Body() dto: PreviewAppointmentSeriesDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<SeriesPreview> {
    return this.series.preview(
      {
        ...this.base(dto),
        count: dto.count,
        until: dto.until,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Post()
  @ApiCreatedResponse({
    type: CreatedAppointmentSeriesDto,
    description:
      'D4: crea la serie con las fechas finales, en UNA transacción (candado de la agenda, bloqueos y EXCLUDE de la BD como árbitro): todas o ninguna. Cada cita con `series` (posición y total); recordatorios por cita como siempre. El prospecto del paciente (DX-556) se mueve una vez. UN `audit_event` CREATE APPOINTMENT `APPOINTMENT_SERIES_CREATED` con la serie, sus citas y sus fechas. Con `notifyPatient` (por defecto), UN email con todas las fechas.',
  })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (como al agendar), menos de 2 o más de 26 fechas, fechas repetidas o intervalo fuera de 1–12',
  })
  @ApiForbiddenResponse({ description: 'Sede no permitida al usuario' })
  @ApiNotFoundResponse({
    description: 'Paciente, profesional o sillón de otra clínica',
  })
  @ApiConflictResponse({
    type: AppointmentSeriesConflictDto,
    description: CONFLICT_DESCRIPTION,
  })
  create(
    @Body() dto: CreateAppointmentSeriesDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CreatedSeries> {
    return this.series.createSeries(
      {
        ...this.base(dto),
        occurrences: dto.occurrences.map((o) => ({ start: new Date(o.start) })),
        notifyPatient: dto.notifyPatient ?? true,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: AppointmentSeriesChangeDto,
    description:
      'D5 «Esta y las siguientes»: cancela en UNA transacción la cita `fromAppointmentId` y las siguientes de la serie que siguen agendadas o confirmadas y aún no empezaron, cada una con los datos y reglas de cancelarla suelta (origen, motivo, aviso y tardía contra la política de su sede). No toca atendidas, en clínica, canceladas ni anteriores, y a propósito NO las manda a «Pendientes por agendar». UN `audit_event` UPDATE APPOINTMENT `APPOINTMENT_SERIES_CANCELLED` con sus ids. Sin ninguna pendiente: 200 con la lista vacía. Cancelar solo esa cita sigue siendo `PATCH /appointments/:id`.',
  })
  @ApiBadRequestResponse({
    description:
      'Id que no es UUID, o sin `cancelledByKind` / `cancelReasonCode` válidos',
  })
  @ApiForbiddenResponse({
    description:
      'Rol sin permiso para cancelar (las reglas de `PATCH /appointments/:id`) o sede no permitida',
  })
  @ApiNotFoundResponse({
    description: 'Serie de otra clínica, o la cita no es de la serie',
  })
  @ApiConflictResponse({
    description:
      'Otra persona cambió el estado de alguna cita mientras tanto (no se canceló ninguna)',
  })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelAppointmentSeriesDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<SeriesChangeResult> {
    return this.series.cancelFollowing(
      id,
      {
        fromAppointmentId: dto.fromAppointmentId,
        cancellation: {
          byKind: dto.cancelledByKind,
          reasonCode: dto.cancelReasonCode,
          reasonText: dto.cancelReasonText,
        },
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Post(':id/move/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: AppointmentSeriesPreviewDto,
    description:
      'D6: cómo quedarían la cita `fromAppointmentId` (a `start`) y las siguientes pendientes de la serie (los mismos días de desplazamiento y la nueva hora de pared, cada una con su duración), con las reglas de moverlas sueltas, sus razones y la alternativa del mismo día. No escribe nada.',
  })
  @ApiBadRequestResponse({
    description: 'Datos inválidos, o `start` igual a la hora de la cita',
  })
  @ApiForbiddenResponse({ description: 'Sede no permitida al usuario' })
  @ApiNotFoundResponse({
    description: 'Serie de otra clínica, o la cita no es de la serie',
  })
  @ApiConflictResponse({
    description:
      'La cita no se puede mover (ya pasó, en curso, atendida o cancelada), o las citas de la serie están en sedes distintas',
  })
  previewMove(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveAppointmentSeriesDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<SeriesPreview> {
    return this.series.previewMove(
      id,
      { fromAppointmentId: dto.fromAppointmentId, start: new Date(dto.start) },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Post(':id/move')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: AppointmentSeriesChangeDto,
    description:
      'D6 «Esta y las siguientes»: mueve en UNA transacción la cita y las siguientes pendientes como en la vista previa (anula su confirmación como al reagendar; siguen en la serie). Sin email nuevo. UN `audit_event` UPDATE APPOINTMENT `APPOINTMENT_SERIES_MOVED` con sus ids, sus nuevas fechas y el movimiento de la pivote. Mover solo esa cita sigue siendo `PATCH /appointments/:id`.',
  })
  @ApiBadRequestResponse({
    description: 'Datos inválidos, o `start` igual a la hora de la cita',
  })
  @ApiForbiddenResponse({ description: 'Sede no permitida al usuario' })
  @ApiNotFoundResponse({
    description: 'Serie de otra clínica, o la cita no es de la serie',
  })
  @ApiConflictResponse({
    type: AppointmentSeriesConflictDto,
    description: `${CONFLICT_DESCRIPTION} También: la cita no se puede mover, o las citas están en sedes distintas.`,
  })
  move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveAppointmentSeriesDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<SeriesChangeResult> {
    return this.series.moveFollowing(
      id,
      { fromAppointmentId: dto.fromAppointmentId, start: new Date(dto.start) },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  private base(dto: PreviewAppointmentSeriesDto | CreateAppointmentSeriesDto) {
    return {
      patientId: dto.patientId,
      providerId: dto.providerId,
      chairId: dto.chairId,
      appointmentTypeId: dto.appointmentTypeId,
      start: new Date(dto.start),
      end: dto.end !== undefined ? new Date(dto.end) : undefined,
      reason: dto.reason,
      notes: dto.notes,
      intervalWeeks: dto.intervalWeeks,
    };
  }
}
