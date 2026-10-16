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
import { AppointmentDto } from './dto/appointment.dto';
import { CreateAppointmentUseCase } from '../application/use-cases/create-appointment.use-case';
import { ListAppointmentsUseCase } from '../application/use-cases/list-appointments.use-case';
import { GetAppointmentUseCase } from '../application/use-cases/get-appointment.use-case';
import { UpdateAppointmentUseCase } from '../application/use-cases/update-appointment.use-case';
import { Appointment } from '../domain/entities/appointment.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { APPOINTMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import {
  isTenantPayload,
  JwtPayload,
} from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { currentRequestId } from '../../../shared/observability/request-context';
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
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Quién mueve la cita, para el `audit_event` del movimiento (DX-121). `null`
   * fuera de una sesión de clínica (no pasa: el RolesGuard ya lo exige).
   */
  private auditContext(
    req: AuthenticatedRequest,
  ): AppointmentAuditContext | undefined {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId || !isTenantPayload(req.user)) return undefined;
    const userAgent = req.headers['user-agent'];
    return {
      tenantId,
      locationId: this.tenantContext.getLocationId() ?? null,
      actor: { userId: req.user.sub, role: req.user.role },
      requestId: currentRequestId() ?? null,
      ip: req.ip ?? null,
      userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
    };
  }

  @Post()
  @ApiCreatedResponse({ type: AppointmentDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos, cita en el pasado, sin hora de fin ni tipo, o tipo desactivado/ajeno',
  })
  @ApiConflictResponse({ description: 'Solape con otra cita' })
  @ApiUnprocessableEntityResponse({
    description: 'Fuera del horario de atención de la sede',
  })
  create(
    @Body() dto: CreateAppointmentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Appointment> {
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
  @ApiOkResponse({ type: [AppointmentDto] })
  @ApiBadRequestResponse({
    description: 'Más de 12 profesionales o alguno ajeno a la clínica',
  })
  list(@Query() query: ListAppointmentsQueryDto): Promise<Appointment[]> {
    return this.listAppointments.execute({
      from: new Date(query.from),
      to: new Date(query.to),
      providerId: query.providerId,
      providerIds: query.providerIds,
      locationId: query.locationId,
    });
  }

  @Get(':id')
  @ApiOkResponse({ type: AppointmentDto })
  get(@Param('id') id: string): Promise<Appointment> {
    return this.getAppointment.execute(id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: AppointmentDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos o al pasado' })
  @ApiForbiddenResponse({ description: 'Rol sin permiso de agenda' })
  @ApiNotFoundResponse({
    description: 'Cita o profesional no encontrados en esta clínica',
  })
  @ApiConflictResponse({
    description:
      'Solape con otra cita del profesional o del paciente (también si otro movimiento ganó la carrera)',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Fuera del horario de atención de la sede de la cita',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAppointmentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Appointment> {
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
