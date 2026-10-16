import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { APPOINTMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  CreateWaitlistEntryUseCase,
  DismissWaitlistEntryUseCase,
  ListWaitlistUseCase,
  ScheduleFromWaitlistUseCase,
} from '../application/use-cases/waitlist.use-cases';
import type {
  WaitlistEntry,
  WaitlistPage,
} from '../domain/entities/waitlist-entry.entity';
import type { AppointmentWriteResult } from '../../appointments/domain/entities/appointment.entity';
import { AppointmentWriteDto } from '../../appointments/presentation/dto/appointment.dto';
import {
  CreateWaitlistEntryDto,
  DismissWaitlistEntryDto,
  ListWaitlistQueryDto,
  ScheduleFromWaitlistDto,
  WaitlistEntryDto,
  WaitlistPageDto,
} from './dto/waitlist.dto';

/**
 * «Pendientes por agendar» (DX-122): pacientes a los que hay que volver a dar
 * cita. Lleva datos personales y de salud: solo personal de la clínica con
 * sesión (los 4 roles de agenda, como las citas: cancelar una cita ya crea una
 * entrada, y agendar desde ella es crear una cita) y RLS por tenant. Altas,
 * descartes y agendados dejan `audit_event` con el paciente (los escriben los
 * casos de uso: el AuditInterceptor no sabe de quién es la entrada).
 */
@ApiTags('waitlist')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@Controller('waitlist')
export class WaitlistController {
  constructor(
    private readonly listEntries: ListWaitlistUseCase,
    private readonly createEntry: CreateWaitlistEntryUseCase,
    private readonly dismissEntry: DismissWaitlistEntryUseCase,
    private readonly scheduleEntry: ScheduleFromWaitlistUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Detrás del RolesGuard siempre hay sesión de clínica y tenant. */
  private ctx(req: AuditableRequest): AuditRequestContext {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return ctx;
  }

  @Get()
  @ApiOkResponse({
    type: WaitlistPageDto,
    description: 'Urgentes primero y, dentro, la más antigua primero.',
  })
  @ApiNotFoundResponse({ description: 'Sede de otra clínica' })
  list(@Query() query: ListWaitlistQueryDto): Promise<WaitlistPage> {
    return this.listEntries.execute({
      status: query.status,
      locationId: query.locationId,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Post()
  @ApiCreatedResponse({ type: WaitlistEntryDto })
  @ApiBadRequestResponse({
    description: 'Texto vacío o largo, duración inválida o tipo desactivado',
  })
  @ApiNotFoundResponse({
    description: 'Paciente, sede o profesional de otra clínica',
  })
  create(
    @Body() dto: CreateWaitlistEntryDto,
    @Req() req: AuditableRequest,
  ): Promise<WaitlistEntry> {
    return this.createEntry.execute(
      {
        patientId: dto.patientId,
        locationId: dto.locationId,
        providerId: dto.providerId,
        appointmentTypeId: dto.appointmentTypeId,
        durationMinutes: dto.durationMinutes,
        priority: dto.priority,
        preferredWindow: dto.preferredWindow,
        note: dto.note,
      },
      this.ctx(req),
    );
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  @ApiOkResponse({ type: WaitlistEntryDto })
  @ApiBadRequestResponse({
    description: 'Sin motivo o de más de 200 caracteres',
  })
  @ApiNotFoundResponse({ description: 'Entrada no encontrada en esta clínica' })
  @ApiConflictResponse({
    description: 'Ya no está abierta (agendada o descartada)',
  })
  dismiss(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DismissWaitlistEntryDto,
    @Req() req: AuditableRequest,
  ): Promise<WaitlistEntry> {
    return this.dismissEntry.execute(id, dto.reason, this.ctx(req));
  }

  @Post(':id/schedule')
  @ApiCreatedResponse({
    type: AppointmentWriteDto,
    description:
      'La cita creada (en la sede de la entrada). La entrada pasa a SCHEDULED en la misma transacción.',
  })
  @ApiBadRequestResponse({ description: 'Datos inválidos o cita en el pasado' })
  @ApiNotFoundResponse({
    description: 'Entrada o profesional no encontrados en esta clínica',
  })
  @ApiConflictResponse({
    description:
      'La entrada ya no está abierta, el horario está bloqueado o se solapa con otra cita',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Fuera del horario de la sede de la entrada',
  })
  schedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ScheduleFromWaitlistDto,
    @Req() req: AuditableRequest,
  ): Promise<AppointmentWriteResult> {
    return this.scheduleEntry.execute(
      id,
      {
        providerId: dto.providerId,
        start: new Date(dto.start),
        end: dto.end !== undefined ? new Date(dto.end) : undefined,
        appointmentTypeId: dto.appointmentTypeId,
        reason: dto.reason,
        notes: dto.notes,
      },
      this.ctx(req),
    );
  }
}
