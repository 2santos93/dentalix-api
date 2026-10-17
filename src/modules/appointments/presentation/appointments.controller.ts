import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { ListAppointmentsQueryDto } from './dto/list-appointments-query.dto';
import {
  AppointmentDto,
  AppointmentListItemDto,
  AppointmentWriteDto,
} from './dto/appointment.dto';
import { PatientBalanceFlags } from '../../collections/application/patient-balance-flags';
import type { OverdueBalance } from '../../collections/domain/overdue-balance';
import { OpeningsDto, OpeningsQueryDto } from './dto/openings.dto';
import { CreateAppointmentUseCase } from '../application/use-cases/create-appointment.use-case';
import { ListAppointmentsUseCase } from '../application/use-cases/list-appointments.use-case';
import { GetAppointmentUseCase } from '../application/use-cases/get-appointment.use-case';
import { UpdateAppointmentUseCase } from '../application/use-cases/update-appointment.use-case';
import {
  Appointment,
  AppointmentWriteResult,
} from '../domain/entities/appointment.entity';
import {
  FindOpeningsUseCase,
  type OpeningsView,
} from '../application/use-cases/find-openings.use-case';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { APPOINTMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import {
  isTenantPayload,
  JwtPayload,
} from '../../../shared/crypto/token.service';
import { auditRequestContext } from '../../audit/presentation/audit-request-context';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AppointmentAuditContext } from '../application/use-cases/update-appointment.use-case';

interface AuthenticatedRequest {
  user: JwtPayload;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

// Agenda de citas (Fase 3): los 5 roles, INCLUYENDO recepción — a diferencia
// de los datos clínicos, la agenda es trabajo de recepción (ver
// APPOINTMENT_ROLES / docs/plans/2026-07-23-fase3-appointments.md).
@ApiTags('appointments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@Controller('appointments')
export class AppointmentsController {
  constructor(
    private readonly createAppointment: CreateAppointmentUseCase,
    private readonly listAppointments: ListAppointmentsUseCase,
    private readonly getAppointment: GetAppointmentUseCase,
    private readonly updateAppointment: UpdateAppointmentUseCase,
    private readonly findOpenings: FindOpeningsUseCase,
    private readonly tenantContext: TenantContextService,
    // DX-150: marca «Saldo vencido» de las tarjetas de la agenda.
    private readonly balanceFlags: PatientBalanceFlags,
  ) {}

  /** Quién escribe, para los `audit_event` de los casos de uso (DX-121/122). */
  private auditContext(
    req: AuthenticatedRequest,
  ): AppointmentAuditContext | undefined {
    return auditRequestContext(req, this.tenantContext);
  }

  @Post()
  @ApiCreatedResponse({
    type: AppointmentWriteDto,
    description:
      'La cita y `warnings` (DX-122: avisos que no impiden agendar, p. ej. un bloqueo de almuerzo que lo permite).',
  })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos, cita en el pasado, sin hora de fin ni tipo, o tipo desactivado/ajeno',
  })
  @ApiConflictResponse({
    description:
      'Solape con otra cita, o el horario está bloqueado para ese profesional o la sede (DX-122)',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Fuera del horario de atención de la sede',
  })
  create(
    @Body() dto: CreateAppointmentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AppointmentWriteResult> {
    // `createdById` comes from the authenticated user (req.user.sub), never
    // from the client body — same convention as PatientsController.create /
    // OdontogramController.create.
    return this.createAppointment.execute({
      patientId: dto.patientId,
      providerId: dto.providerId,
      start: new Date(dto.start),
      end: dto.end !== undefined ? new Date(dto.end) : undefined,
      reason: dto.reason,
      notes: dto.notes,
      createdById: req.user.sub,
      appointmentTypeId: dto.appointmentTypeId,
    });
  }

  @Get()
  @ApiOkResponse({
    type: [AppointmentListItemDto],
    description:
      'Cada cita con `balance` (DX-150): marca «Saldo vencido» de su paciente, calculada para todo el lote en un número fijo de consultas (sin N+1). El importe, solo ADMIN y RECEPTION.',
  })
  @ApiBadRequestResponse({
    description: 'Más de 12 profesionales o alguno ajeno a la clínica',
  })
  async list(
    @Query() query: ListAppointmentsQueryDto,
    @Req() req: { user: JwtPayload },
  ): Promise<(Appointment & { balance: OverdueBalance })[]> {
    const appointments = await this.listAppointments.execute({
      from: new Date(query.from),
      to: new Date(query.to),
      providerId: query.providerId,
      providerIds: query.providerIds,
      locationId: query.locationId,
    });
    const flags = await this.balanceFlags.forPatients(
      appointments.map((a) => a.patientId),
      isTenantPayload(req.user) ? req.user.role : null,
    );
    return appointments.map((a) => ({
      ...a,
      balance: flags.get(a.patientId) ?? {
        hasOverdue: false,
        overdueDays: null,
      },
    }));
  }

  // Antes de `:id`: si no, «openings» se tomaría por el id de una cita.
  @Get('openings')
  @ApiOkResponse({
    type: OpeningsDto,
    description:
      'DX-122 «Buscar hueco»: huecos del profesional dentro del horario de la sede (su zona horaria), fuera de bloqueos y sin solape con sus citas (ni con las del paciente, si se indica). Nunca en el pasado.',
  })
  @ApiBadRequestResponse({
    description:
      'Fechas inválidas, al revés o más de 31 días; duración fuera de 5–480',
  })
  @ApiNotFoundResponse({
    description: 'Sede, profesional o paciente de otra clínica',
  })
  openings(@Query() query: OpeningsQueryDto): Promise<OpeningsView> {
    return this.findOpenings.execute({
      providerId: query.providerId,
      locationId: query.locationId,
      from: query.from,
      to: query.to,
      durationMinutes: query.durationMinutes,
      patientId: query.patientId,
    });
  }

  @Get(':id')
  @ApiOkResponse({ type: AppointmentDto })
  get(@Param('id') id: string): Promise<Appointment> {
    return this.getAppointment.execute(id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: AppointmentWriteDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos o al pasado' })
  @ApiForbiddenResponse({ description: 'Rol sin permiso de agenda' })
  @ApiNotFoundResponse({
    description: 'Cita o profesional no encontrados en esta clínica',
  })
  @ApiConflictResponse({
    description:
      'Solape con otra cita del profesional o del paciente (también si otro movimiento ganó la carrera), o el nuevo horario está bloqueado (DX-122)',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Fuera del horario de atención de la sede de la cita',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAppointmentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AppointmentWriteResult> {
    return this.updateAppointment.execute(
      id,
      {
        start: dto.start !== undefined ? new Date(dto.start) : undefined,
        end: dto.end !== undefined ? new Date(dto.end) : undefined,
        providerId: dto.providerId,
        status: dto.status,
        reason: dto.reason,
        notes: dto.notes,
      },
      this.auditContext(req),
    );
  }
}
