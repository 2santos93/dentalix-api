import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import {
  NO_COVERAGE,
  PatientCoverageFlags,
  type CoverageSummary,
} from '../../patient-coverages/application/patient-coverage-flags';
import type { OverdueBalance } from '../../collections/domain/overdue-balance';
import { PatientMedicalAlertFlags } from '../../medical-history/application/patient-medical-alert-flags';
import {
  NO_ANAMNESIS_FLAGS,
  type MedicalAlertFlags,
} from '../../medical-history/domain/medical-alert-flags';
import { OpeningsDto, OpeningsQueryDto } from './dto/openings.dto';
import { InClinicQueryDto, InClinicViewDto } from './dto/in-clinic.dto';
import {
  ListInClinicUseCase,
  type InClinicItem,
  type InClinicView,
} from '../application/use-cases/list-in-clinic.use-case';
import {
  FRONT_DESK_ROLES,
  PATIENT_FLOW_MESSAGES,
} from '../domain/patient-flow';
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
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { ClinicRole } from '@prisma/client';
import { MoveToOpeningDto } from './dto/move-to-opening.dto';
import {
  WANTS_EARLIER_FORBIDDEN_MESSAGE,
  canChangeWantsEarlier,
} from '../domain/wants-earlier';
import { OPENING_ASSIGN_FORBIDDEN_MESSAGE } from '../../waitlist/domain/waitlist-offer-rules';
import { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
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
    // DX-153: resumen de cobertura del paciente en las tarjetas.
    private readonly coverageFlags: PatientCoverageFlags,
    // DX-247: banderas médicas mínimas (nunca la historia) en las tarjetas.
    private readonly medicalAlertFlags: PatientMedicalAlertFlags,
    private readonly audit: RecordAuditEventUseCase,
    private readonly listInClinic: ListInClinicUseCase,
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
  @ApiForbiddenResponse({
    description:
      'DX-210: `wantsEarlier` solo lo marcan RECEPTION, DENTIST y ADMIN',
  })
  async create(
    @Body() dto: CreateAppointmentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AppointmentWriteResult> {
    const ctx = this.auditContext(req);
    if (dto.wantsEarlier && !canChangeWantsEarlier(ctx?.actor.role ?? null)) {
      throw new ForbiddenException(WANTS_EARLIER_FORBIDDEN_MESSAGE);
    }
    // `createdById` comes from the authenticated user (req.user.sub), never
    // from the client body — same convention as PatientsController.create /
    // OdontogramController.create.
    const created = await this.createAppointment.execute({
      patientId: dto.patientId,
      providerId: dto.providerId,
      start: new Date(dto.start),
      end: dto.end !== undefined ? new Date(dto.end) : undefined,
      reason: dto.reason,
      notes: dto.notes,
      createdById: req.user.sub,
      appointmentTypeId: dto.appointmentTypeId,
      wantsEarlier: dto.wantsEarlier,
    });
    // DX-210: nacer marcada «Adelantar si hay hueco» también queda auditado.
    if (created.wantsEarlier && ctx) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        actor: {
          kind: 'user',
          userId: ctx.actor.userId,
          role: ctx.actor.role,
        },
        action: 'UPDATE',
        resourceType: 'APPOINTMENT',
        resourceId: created.id,
        patient: { kind: 'patient', id: created.patientId },
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { reason: 'WANTS_EARLIER_ON' },
      });
    }
    return created;
  }

  @Get()
  @ApiOkResponse({
    type: [AppointmentListItemDto],
    description:
      'Cada cita con `balance` (DX-150): marca «Saldo vencido» de su paciente, calculada para todo el lote en un número fijo de consultas (sin N+1). El importe, solo ADMIN y RECEPTION. Con `coverage` (DX-153): resumen de la cobertura principal del paciente, también por lote. Y con `medicalAlerts` (DX-247): SOLO banderas de la anamnesis (alerta, premedicación, al día / caducada / ausente y los códigos de alerta), nunca la historia médica.',
  })
  @ApiBadRequestResponse({
    description: 'Más de 12 profesionales o alguno ajeno a la clínica',
  })
  async list(
    @Query() query: ListAppointmentsQueryDto,
    @Req() req: { user: JwtPayload },
  ): Promise<
    (Appointment & {
      balance: OverdueBalance;
      coverage: CoverageSummary;
      medicalAlerts: MedicalAlertFlags;
    })[]
  > {
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
    const patientIds = appointments.map((a) => a.patientId);
    const coverage = await this.coverageFlags.forPatients(patientIds);
    const medical = await this.medicalAlertFlags.forPatients(patientIds);
    return appointments.map((a) => ({
      ...a,
      balance: flags.get(a.patientId) ?? {
        hasOverdue: false,
        overdueDays: null,
      },
      coverage: coverage.get(a.patientId) ?? NO_COVERAGE,
      medicalAlerts: medical.get(a.patientId) ?? NO_ANAMNESIS_FLAGS,
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

  // Antes de `:id`, por la misma razón que «openings».
  @Get('in-clinic')
  @ApiOkResponse({
    type: InClinicViewDto,
    description:
      'DX-200 panel «En clínica» de la sede del request (X-Location-Id): en espera, en sillón y listo para cobrar de un día civil en la zona de la sede, con los minutos calculados con el reloj del servidor y la puntualidad de la llegada. Solo nombre, horas y, desde DX-247, las banderas médicas mínimas (`medicalAlerts`), nunca la historia. DENTIST: solo sus pacientes («Te esperan»); RECEPTION, ASSISTANT y ADMIN: toda la sede.',
  })
  @ApiBadRequestResponse({
    description:
      'Sin sede (X-Location-Id), sede de otra clínica o fecha inválida',
  })
  async inClinic(
    @Query() query: InClinicQueryDto,
    @Req() req: { user: JwtPayload },
  ): Promise<
    InClinicView<InClinicItem & { medicalAlerts: MedicalAlertFlags }>
  > {
    const view = await this.listInClinic.execute({
      locationId: this.tenantContext.getLocationId(),
      date: query.date,
      role: isTenantPayload(req.user) ? req.user.role : null,
      userId: req.user.sub,
    });
    // DX-247: la misma alerta que la agenda, en una sola lectura por lote.
    const medical = await this.medicalAlertFlags.forPatients(
      [...view.waiting, ...view.inChair, ...view.readyForCheckout].map(
        (i) => i.patientId,
      ),
    );
    const withAlerts = (items: InClinicItem[]) =>
      items.map((i) => ({
        ...i,
        medicalAlerts: medical.get(i.patientId) ?? NO_ANAMNESIS_FLAGS,
      }));
    return {
      ...view,
      waiting: withAlerts(view.waiting),
      inChair: withAlerts(view.inChair),
      readyForCheckout: withAlerts(view.readyForCheckout),
    };
  }

  @Get(':id')
  @ApiOkResponse({ type: AppointmentDto })
  get(@Param('id') id: string): Promise<Appointment> {
    return this.getAppointment.execute(id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: AppointmentWriteDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos o al pasado' })
  @ApiForbiddenResponse({
    description:
      'Rol sin permiso de agenda, o sin permiso para ese paso del flujo en la clínica (DX-200)',
  })
  @ApiNotFoundResponse({
    description: 'Cita o profesional no encontrados en esta clínica',
  })
  @ApiConflictResponse({
    description:
      'Solape con otra cita del profesional o del paciente (también si otro movimiento ganó la carrera), el nuevo horario está bloqueado (DX-122), o un salto imposible del flujo en la clínica o la cita cambió mientras tanto (DX-200)',
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
        wantsEarlier: dto.wantsEarlier,
      },
      this.auditContext(req),
    );
  }

  @Post(':id/undo-arrival')
  @HttpCode(HttpStatus.OK)
  @Roles(...FRONT_DESK_ROLES)
  @RolesDeniedMessage(PATIENT_FLOW_MESSAGES.arriveForbidden)
  @ApiOkResponse({
    type: AppointmentWriteDto,
    description:
      'DX-200 «Deshacer llegada»: el paciente marcado «Llegó» por error vuelve al estado que tenía (SCHEDULED o CONFIRMED) y se borra `arrivedAt`. Solo desde ARRIVED (antes de pasar al sillón); queda en auditoría (`ARRIVAL_UNDONE`).',
  })
  @ApiForbiddenResponse({
    description: 'Solo RECEPTION, ASSISTANT y ADMIN',
  })
  @ApiNotFoundResponse({ description: 'Cita no encontrada en esta clínica' })
  @ApiConflictResponse({
    description:
      'La cita no está en espera (ya pasó al sillón, o nunca llegó), o cambió mientras tanto',
  })
  undoArrival(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<AppointmentWriteResult> {
    const ctx = this.auditContext(req);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.updateAppointment.undoArrival(id, ctx);
  }

  @Patch(':id/opening')
  @Roles(ClinicRole.ADMIN, ClinicRole.RECEPTION)
  @RolesDeniedMessage(OPENING_ASSIGN_FORBIDDEN_MESSAGE)
  @ApiOkResponse({
    type: AppointmentWriteDto,
    description:
      'DX-210 «Asignar» desde «Ocupar este hueco»: adelanta una cita marcada «Adelantar si hay hueco» al hueco libre con las reglas de un reagendado (pasado, horario, bloqueos, solape del profesional y del paciente) y le quita la marca en la misma transacción. Su hora original queda libre.',
  })
  @ApiBadRequestResponse({
    description: 'Datos inválidos o hueco en el pasado',
  })
  @ApiForbiddenResponse({
    description: 'Solo RECEPTION y ADMIN asignan huecos',
  })
  @ApiNotFoundResponse({
    description: 'Cita o profesional no encontrados en esta clínica',
  })
  @ApiConflictResponse({
    description:
      'La cita ya no está marcada (otra persona la movió), el hueco no es anterior a la cita, o ya está ocupado o bloqueado',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Fuera del horario de atención de la sede de la cita',
  })
  moveToOpening(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveToOpeningDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AppointmentWriteResult> {
    const ctx = this.auditContext(req);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.updateAppointment.moveToOpening(
      id,
      {
        start: new Date(dto.start),
        end: dto.end !== undefined ? new Date(dto.end) : undefined,
        providerId: dto.providerId,
      },
      ctx,
    );
  }
}
