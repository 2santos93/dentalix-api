import { Audit } from '../../audit/presentation/audit.decorator';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
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
  CancellationPreviewDto,
} from './dto/appointment.dto';
import { PatientAttendanceFlags } from '../application/attendance/patient-attendance';
import { NO_INCIDENTS, type PatientIncidentCounts } from '../domain/attendance';
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
import { CreateWalkInDto, WalkInResultDto } from './dto/walk-in.dto';
import {
  CreateWalkInUseCase,
  type WalkInResult,
} from '../application/use-cases/create-walk-in.use-case';
import { WALK_IN_MESSAGES, WALK_IN_ROLES } from '../domain/walk-in';
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
import {
  UpdateAppointmentUseCase,
  type CancellationPreview,
} from '../application/use-cases/update-appointment.use-case';
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
import {
  RESERVED_OVERRIDE_REPOSITORY,
  type ReservedOverrideRepository,
} from '../domain/ports/reserved-override-repository.port';

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
    // DX-279: insignia «inasistencias · cancelaciones tardías» de las tarjetas.
    private readonly attendanceFlags: PatientAttendanceFlags,
    // DX-446: motivo de «Agendar igualmente» fuera de la auditoría.
    @Inject(RESERVED_OVERRIDE_REPOSITORY)
    private readonly reservedOverrides: ReservedOverrideRepository,
    // DX-470: «Atender sin cita».
    private readonly createWalkIn: CreateWalkInUseCase,
  ) {}

  /** Quién escribe, para los `audit_event` de los casos de uso (DX-121/122). */
  private auditContext(
    req: AuthenticatedRequest,
  ): AppointmentAuditContext | undefined {
    return auditRequestContext(req, this.tenantContext);
  }

  /**
   * DX-446: cita agendada o movida saltándose un hueco reservado. El motivo
   * va a `appointment_reserved_overrides` y el `audit_event` (aparte del
   * evento HTTP genérico) solo lleva el id de esa fila y los bloques: nada de
   * texto libre en la auditoría (DX-009). En la respuesta, `reservedOverride`.
   */
  private async auditReservedOverride(
    appointment: AppointmentWriteResult,
    action: 'CREATE' | 'UPDATE',
    ctx: AppointmentAuditContext | undefined,
  ): Promise<void> {
    if (!appointment.reservedOverride || !ctx) return;
    await this.reservedOverrides.record(
      {
        appointmentId: appointment.id,
        patientId: appointment.patientId,
        locationId: appointment.locationId,
        blockIds: appointment.reservedOverride.blockIds,
        reason: appointment.reservedOverride.reason,
        action,
      },
      ctx,
    );
  }

  /** La escritura explícita de vínculos es distinta de la traza HTTP genérica. */
  private async auditPlanItems(
    appointment: AppointmentWriteResult,
    planItemIds: string[] | undefined,
    action: 'CREATE' | 'UPDATE',
    ctx: AppointmentAuditContext | undefined,
  ): Promise<void> {
    if (planItemIds === undefined || !ctx) return;
    await this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action,
      resourceType: 'APPOINTMENT',
      resourceId: appointment.id,
      patient: { kind: 'patient', id: appointment.patientId },
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        reason: 'APPOINTMENT_PLAN_ITEMS',
        changedFields: ['planItemIds'],
      },
    });
  }

  @Audit({
    action: 'CREATE',
    resource: 'APPOINTMENT',
    resourceId: { response: 'id' },
    patient: { response: 'patientId' },
  })
  @Post()
  @ApiCreatedResponse({
    type: AppointmentWriteDto,
    description:
      'La cita y `warnings` (DX-122: avisos que no impiden agendar, p. ej. un bloqueo de almuerzo que lo permite).',
  })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos, cita en el pasado, sin hora de fin ni tipo, o tipo desactivado/ajeno; DX-211: sin profesional (ni el del sillón), o sillón de otra sede o desactivado',
  })
  @ApiConflictResponse({
    description:
      'Solape con otra cita (del profesional, del paciente o, DX-211, del sillón: «El sillón X ya está ocupado de HH:MM a HH:MM»), el horario está bloqueado para ese profesional o la sede (DX-122), o es un hueco reservado para otros tipos y aún sin liberar (DX-446: `code: RESERVED_SLOT`, `canOverride` dice si quien agenda puede reintentar con `overrideReason`)',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Fuera del horario de atención de la sede',
  })
  @ApiForbiddenResponse({
    description:
      'DX-210: `wantsEarlier` solo lo marcan RECEPTION, DENTIST y ADMIN. DX-446: `overrideReason` solo lo envían ADMIN y DENTIST',
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
      planItemIds: dto.planItemIds,
      actorRole: ctx?.actor.role ?? null,
      overrideReason: dto.overrideReason,
      chairId: dto.chairId,
    });
    await this.auditReservedOverride(created, 'CREATE', ctx);
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
    await this.auditPlanItems(created, dto.planItemIds, 'CREATE', ctx);
    return created;
  }

  @Get()
  @ApiOkResponse({
    type: [AppointmentListItemDto],
    description:
      'Cada cita con `balance` (DX-150): marca «Saldo vencido» de su paciente, calculada para todo el lote en un número fijo de consultas (sin N+1). El importe, solo ADMIN y RECEPTION. Con `coverage` (DX-153): resumen de la cobertura principal del paciente, también por lote. Y con `medicalAlerts` (DX-247): SOLO banderas de la anamnesis (alerta, premedicación, al día / caducada / ausente el día civil de la cita en la zona de su sede, y los códigos de alerta), nunca la historia médica ni las notas de la cita (disponibles en GET /appointments/:id). Con `attendance` (DX-279): inasistencias y cancelaciones tardías del paciente en 12 meses, por lote; sin el detalle libre del motivo de cancelación (`cancelReasonText`, en GET /appointments/:id).',
  })
  @ApiBadRequestResponse({
    description:
      'Más de 12 profesionales o alguno ajeno a la clínica; DX-211: más de 12 sillones, alguno de otra sede o clínica, o `chairIds` sin sede',
  })
  async list(
    @Query() query: ListAppointmentsQueryDto,
    @Req() req: { user: JwtPayload },
  ): Promise<
    (Omit<
      Appointment,
      'notes' | 'cancelReasonText' | 'triageFlags' | 'triageNote'
    > & {
      balance: OverdueBalance;
      coverage: CoverageSummary;
      medicalAlerts: MedicalAlertFlags;
      attendance: PatientIncidentCounts;
    })[]
  > {
    const appointments = await this.listAppointments.execute({
      from: new Date(query.from),
      to: new Date(query.to),
      providerId: query.providerId,
      providerIds: query.providerIds,
      locationId: query.locationId,
      chairIds: query.chairIds,
    });
    const flags = await this.balanceFlags.forPatients(
      appointments.map((a) => a.patientId),
      isTenantPayload(req.user) ? req.user.role : null,
    );
    const patientIds = appointments.map((a) => a.patientId);
    const coverage = await this.coverageFlags.forPatients(patientIds);
    // DX-247: el estado de la anamnesis el día civil de CADA cita en su sede.
    const medical = await this.medicalAlertFlags.forAppointments(appointments);
    const attendance = await this.attendanceFlags.forPatients(patientIds);
    // DX-470: el triaje (datos de salud) no sale en la agenda: solo en GET
    // /appointments/:id y en el panel «En clínica».
    return appointments.map(
      ({
        notes: _notes,
        cancelReasonText: _text,
        triageFlags: _flags,
        triageNote: _note,
        ...a
      }) => ({
        ...a,
        balance: flags.get(a.patientId) ?? {
          hasOverdue: false,
          overdueDays: null,
        },
        coverage: coverage.get(a.patientId) ?? NO_COVERAGE,
        medicalAlerts: medical.get(a.id) ?? NO_ANAMNESIS_FLAGS,
        attendance: attendance.get(a.patientId) ?? NO_INCIDENTS,
      }),
    );
  }

  @Post('walk-in')
  @Roles(...WALK_IN_ROLES)
  @RolesDeniedMessage(WALK_IN_MESSAGES.forbidden)
  @ApiCreatedResponse({
    type: WalkInResultDto,
    description:
      'DX-470 «Atender sin cita», en una transacción: el paciente (existente por `patientId`, o alta mínima `newPatient` con nombre, apellido y teléfono) y una cita de tipo urgente DESDE AHORA ya en «En clínica» (ARRIVED, `arrivedAt` = reloj del servidor, `walkIn`), con las señales y la nota de triaje. Va al primer hueco RESERVED libre de hoy del profesional que admite el tipo urgente (DX-446); con `overbookReason`, en sobrecupo ahora (`overbooked`, motivo en `appointment_reserved_overrides`). Sede: la de X-Location-Id (o la de escritura de la sesión), entre las permitidas al usuario; autor, el del token. Queda en auditoría (`WALK_IN_PATIENT`, `WALK_IN_ARRIVAL`, `WALK_IN_OVERBOOK`) sin el triaje ni el motivo.',
  })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos: ni `patientId` ni `newPatient` (o los dos), señales fuera de las 6, nota de más de 200, motivo del sobrecupo fuera de 5–300, tipo no urgente o desactivado, o el profesional no atiende en la sede',
  })
  @ApiForbiddenResponse({
    description:
      'Solo RECEPTION, ASSISTANT y ADMIN (marcan la llegada); sede no permitida (`LOCATION_NOT_ALLOWED`)',
  })
  @ApiNotFoundResponse({
    description: 'Paciente o profesional que no son de esta clínica',
  })
  @ApiConflictResponse({
    description:
      '`NO_RESERVED_SLOT` (`canOverbook`): no queda hueco reservado libre hoy, se puede reintentar con `overbookReason`; `PATIENT_DUPLICATE` (`existingPatientId` y `existingPatient` con `id`, `firstName`, `lastName`): el documento del alta mínima ya es de otro paciente (se comprueba antes que el hueco); sin tipo urgente activo; un bloqueo que no deja agendar; el paciente ya está en otra cita a esa hora; u otra persona ocupó el hueco a la vez',
  })
  async walkIn(
    @Body() dto: CreateWalkInDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<WalkInResult> {
    const ctx = this.auditContext(req);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.createWalkIn.execute(
      {
        patientId: dto.patientId,
        newPatient: dto.newPatient,
        providerId: dto.providerId,
        appointmentTypeId: dto.appointmentTypeId,
        triageFlags: dto.triageFlags,
        triageNote: dto.triageNote,
        overbookReason: dto.overbookReason,
      },
      ctx,
    );
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
    // DX-247: la misma alerta que la agenda, en una sola lectura por lote,
    // evaluada el día del panel en la zona de la sede.
    const medical = await this.medicalAlertFlags.forPatients(
      [...view.waiting, ...view.inChair, ...view.readyForCheckout].map(
        (i) => i.patientId,
      ),
      { date: view.date, timeZone: view.timeZone },
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

  @Get(':id/cancellation-preview')
  @ApiOkResponse({
    type: CancellationPreviewDto,
    description:
      'DX-279: antes de confirmar la cancelación en la agenda, los minutos de aviso si se cancelara AHORA (reloj del servidor, UTC) y si sería tardía para el paciente según la política vigente de la sede de la cita. Mismo cálculo que el PATCH a CANCELLED; la de la clínica nunca es tardía.',
  })
  @ApiBadRequestResponse({ description: 'Id que no es UUID' })
  @ApiForbiddenResponse({
    description: 'La cita es de una sede no permitida al usuario (DX-089)',
  })
  @ApiNotFoundResponse({ description: 'Cita no encontrada en esta clínica' })
  cancellationPreview(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CancellationPreview> {
    return this.updateAppointment.cancellationPreview(id);
  }

  @Get(':id')
  @ApiOkResponse({ type: AppointmentDto })
  get(@Param('id') id: string): Promise<Appointment> {
    return this.getAppointment.execute(id);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'APPOINTMENT',
    resourceId: { param: 'id' },
    patient: { response: 'patientId' },
  })
  @Patch(':id')
  @ApiOkResponse({
    type: AppointmentWriteDto,
    description:
      'La cita, los avisos y `planItemsReservedElsewhere` (DX-273: tratamientos de la cita que reserva otra cita, p. ej. tras «Llegó»). Al sacarla de COMPLETED, además `completedExit`.',
  })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos o al pasado, salida de COMPLETED sin `statusReason` válido (DX-273), o cancelar sin `cancelledByKind` o sin `cancelReasonCode` (DX-279), con el mensaje en español',
  })
  @ApiForbiddenResponse({
    description:
      'Rol sin permiso de agenda, sin permiso para ese paso del flujo en la clínica (DX-200), o RECEPTION/ASSISTANT sacando una cita de COMPLETED (DX-273), o `overrideReason` sin ser ADMIN ni DENTIST (DX-446)',
  })
  @ApiNotFoundResponse({
    description: 'Cita, profesional o sillón no encontrados en esta clínica',
  })
  @ApiConflictResponse({
    description:
      'Solape con otra cita del profesional, del paciente o del sillón (DX-211, con su nombre y horas; también si otro movimiento ganó la carrera), el nuevo horario está bloqueado (DX-122) o reservado sin liberar (DX-446, `RESERVED_SLOT`), o un salto imposible del flujo en la clínica o la cita cambió mientras tanto (DX-200)',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Fuera del horario de atención de la sede de la cita',
  })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAppointmentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AppointmentWriteResult> {
    const ctx = this.auditContext(req);
    const updated = await this.updateAppointment.execute(
      id,
      {
        start: dto.start !== undefined ? new Date(dto.start) : undefined,
        end: dto.end !== undefined ? new Date(dto.end) : undefined,
        providerId: dto.providerId,
        chairId: dto.chairId,
        status: dto.status,
        reason: dto.reason,
        notes: dto.notes,
        wantsEarlier: dto.wantsEarlier,
        planItemIds: dto.planItemIds,
        statusReason: dto.statusReason,
        cancellation: {
          byKind: dto.cancelledByKind,
          reasonCode: dto.cancelReasonCode,
          reasonText: dto.cancelReasonText,
        },
        overrideReason: dto.overrideReason,
      },
      ctx,
    );
    await this.auditReservedOverride(updated, 'UPDATE', ctx);
    await this.auditPlanItems(updated, dto.planItemIds, 'UPDATE', ctx);
    return updated;
  }

  @Post(':id/plan-items/:planItemId/claim')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: AppointmentWriteDto,
    description:
      'DX-273 «Traer a esta cita»: con el paciente en la clínica (ARRIVED, IN_CHAIR o READY_FOR_CHECKOUT), la cita pasa a reservar un tratamiento suyo que reservaba otra cita viva; esa otra cita lo deja (su vínculo se retira). Una transacción, con las dos citas bloqueadas, y un `audit_event` APPOINTMENT_PLAN_ITEMS en cada una (`params`: planItemId, fromAppointmentId, toAppointmentId). Si ninguna otra cita lo reserva, solo recupera la reserva; si ya la tiene, no cambia nada.',
  })
  @ApiBadRequestResponse({ description: 'Ids que no son UUID' })
  @ApiForbiddenResponse({
    description:
      'Sede de la cita no permitida, o la cita que lo reserva es de una sede no permitida al usuario (DX-089; no se dice cuál)',
  })
  @ApiNotFoundResponse({
    description:
      'La cita no existe en esta clínica, o el tratamiento no está en ella',
  })
  @ApiConflictResponse({
    description:
      'La cita no tiene al paciente en la clínica, el tratamiento ya lo tiene otra cita de hoy con el paciente en la clínica (DX-288: con varias peticiones a la vez solo la primera lo trae; dice su hora y su sede si la sede está permitida), otra cita lo tomó a la vez (dice cuál), o la cita cambió mientras tanto',
  })
  claimPlanItem(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('planItemId', ParseUUIDPipe) planItemId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<AppointmentWriteResult> {
    const ctx = this.auditContext(req);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.updateAppointment.claimPlanItem(id, planItemId, ctx);
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
