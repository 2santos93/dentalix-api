import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { APPOINTMENT_REPOSITORY } from '../../domain/ports/appointment-repository.port';
import type {
  AppointmentRepository,
  UpdateAppointmentRepoInput,
} from '../../domain/ports/appointment-repository.port';
import {
  Appointment,
  AppointmentWriteResult,
  PlanItemReservedElsewhere,
} from '../../domain/entities/appointment.entity';
import { checkScheduleBlocks } from '../schedule-block-check';
import { SCHEDULE_BLOCK_REPOSITORY } from '../../../schedule-blocks/domain/ports/schedule-block-repository.port';
import type { ScheduleBlockRepository } from '../../../schedule-blocks/domain/ports/schedule-block-repository.port';
import { LOCATION_SCHEDULE_REPOSITORY } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import type { LocationScheduleRepository } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import {
  businessHoursErrorMessage,
  fitsBusinessHours,
} from '../../../location-schedule/application/business-hours';
import { STAFF_REPOSITORY } from '../../../staff/domain/ports/staff-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import {
  OVERLAP_MESSAGES,
  overlapExclusionScope,
} from '../appointment-overlap-error';
import {
  WANTS_EARLIER_FORBIDDEN_MESSAGE,
  WANTS_EARLIER_GONE_MESSAGE,
  WANTS_EARLIER_NOT_EARLIER_MESSAGE,
  canChangeWantsEarlier,
} from '../../domain/wants-earlier';
import { MOVABLE_STATUSES } from '../../../waitlist/domain/opening-candidates';
import { LOCATION_REPOSITORY } from '../../../locations/domain/ports/location-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { assertAttendsAt } from '../../../staff/domain/provider-location';
import { ProviderAvailabilityService } from '../../../provider-schedule/application/provider-availability.service';
import {
  NO_WARNINGS,
  collectWarnings,
  type Warnings,
} from '../appointment-warnings';
import {
  FLOW_TIMESTAMP_FIELD,
  FRONT_DESK_ROLES,
  PATIENT_FLOW_MESSAGES,
  checkStatusTransition,
  isCompletedExit,
  isInClinic,
  normalizeStatusReason,
} from '../../domain/patient-flow';
import {
  PLAN_ITEM_CLAIM_NOT_IN_CLINIC_MESSAGE,
  PLAN_ITEM_CLAIM_NOT_LINKED_MESSAGE,
  planItemsClosedMessage,
  planItemsEditable,
} from '../../domain/plan-item-reservation';

/**
 * Lo que el cliente puede cambiar. `revokeConfirmations` y los indicadores de
 * confirmación NO: los decide este use-case.
 */
export type UpdateAppointmentInput = Omit<
  UpdateAppointmentRepoInput,
  | 'revokeConfirmations'
  | 'enqueueWaitlist'
  | 'resolveWaitlist'
  | 'requireWantsEarlier'
  | 'arrivedAt'
  | 'seatedAt'
  | 'readyForCheckoutAt'
  | 'preArrivalStatus'
  | 'expectStatus'
  | 'completedExit'
  | 'audit'
> & {
  /**
   * DX-273: motivo para sacar la cita de COMPLETED (obligatorio entonces,
   * 3–500 caracteres tras recortar). En cualquier otro cambio se ignora.
   */
  statusReason?: string | null;
};

/** DX-273 «Traer a esta cita»: mensajes en español. */
export const PLAN_ITEM_CLAIM_MESSAGES = {
  notInClinic: PLAN_ITEM_CLAIM_NOT_IN_CLINIC_MESSAGE,
  notLinked: PLAN_ITEM_CLAIM_NOT_LINKED_MESSAGE,
} as const;

/**
 * Sin aviso (DX-273): la cita ya no reserva nada (cancelada, no-show) o la
 * visita terminó (completada, revisión M3).
 */
const NOT_RESERVING: ReadonlySet<AppointmentStatus> = new Set([
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
  AppointmentStatus.COMPLETED,
]);

/** DX-210: el hueco libre al que se adelanta una cita marcada. */
export interface MoveToOpeningInput {
  start: Date;
  /** Si falta: `start` + la duración actual de la cita. */
  end?: Date;
  /** Si falta: el mismo profesional. */
  providerId?: string;
}

/** Estados que mandan al paciente a «Pendientes por agendar» (DX-122). */
const WAITLIST_STATUSES: ReadonlySet<AppointmentStatus> = new Set([
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
]);

/**
 * Quién mueve la cita y desde dónde (DX-121): con esto el use-case deja el
 * `audit_event` del movimiento, que necesita la hora y el profesional ANTES del
 * cambio — algo que el AuditInterceptor, que solo ve la respuesta, no tiene.
 */
export type AppointmentAuditContext = AuditRequestContext;

@Injectable()
export class UpdateAppointmentUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly repo: AppointmentRepository,
    @Inject(LOCATION_SCHEDULE_REPOSITORY)
    private readonly schedule: LocationScheduleRepository,
    // DX-121: mover a otro profesional exige que sea de ESTA clínica (mismo
    // criterio que CreateAppointmentUseCase).
    @Inject(STAFF_REPOSITORY)
    private readonly staff: StaffRepository,
    private readonly audit: RecordAuditEventUseCase,
    // DX-122: no mover encima de un bloqueo que no lo permite.
    @Inject(SCHEDULE_BLOCK_REPOSITORY)
    private readonly blocks: ScheduleBlockRepository,
    // DX-200: la llegada solo se marca el día de la cita en la zona de su sede.
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    private readonly tenantContext: TenantContextService,
    // DX-233: mover fuera del horario del profesional destino → aviso, o 409
    // en modo estricto.
    private readonly availability: ProviderAvailabilityService,
  ) {}

  async execute(
    id: string,
    patch: UpdateAppointmentInput,
    auditContext?: AppointmentAuditContext,
  ): Promise<AppointmentWriteResult> {
    return this.apply(id, patch, auditContext, false);
  }

  /**
   * DX-210 «Asignar» desde «Ocupar este hueco»: mueve una cita marcada
   * «Adelantar si hay hueco» al hueco libre, con TODAS las reglas de un
   * reagendado (pasado, horario de la sede, bloqueos, solape del profesional y
   * del paciente — DX-036), y le quita la marca en la misma transacción. Si ya
   * no está marcada (otra persona la movió), 409. Su hueco original queda
   * libre, sin ofrecerlo en cadena.
   */
  async moveToOpening(
    id: string,
    slot: MoveToOpeningInput,
    auditContext: AppointmentAuditContext,
  ): Promise<AppointmentWriteResult> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('Cita no encontrada');
    this.tenantContext.assertLocationAllowed(existing.locationId);
    if (!existing.wantsEarlier || !MOVABLE_STATUSES.includes(existing.status)) {
      throw new ConflictException(WANTS_EARLIER_GONE_MESSAGE);
    }
    // Adelantar, no retrasar: el hueco empieza antes que la cita.
    if (slot.start.getTime() >= existing.start.getTime()) {
      throw new ConflictException(WANTS_EARLIER_NOT_EARLIER_MESSAGE);
    }
    const duration = existing.end.getTime() - existing.start.getTime();
    return this.apply(
      id,
      {
        start: slot.start,
        end: slot.end ?? new Date(slot.start.getTime() + duration),
        providerId: slot.providerId,
        wantsEarlier: false,
      },
      auditContext,
      true,
    );
  }

  private async apply(
    id: string,
    input: UpdateAppointmentInput,
    auditContext: AppointmentAuditContext | undefined,
    fromOpening: boolean,
  ): Promise<AppointmentWriteResult> {
    const { statusReason, ...patch } = input;
    const existing = await this.repo.findById(id);
    if (!existing) {
      // Same rationale as the Patient use cases: a missing row and a row
      // that belongs to another tenant are indistinguishable here (RLS
      // makes cross-tenant rows invisible), so both surface as NotFound.
      throw new NotFoundException('Appointment not found');
    }
    // DX-089: una cita de una sede no permitida es 403 (no 404: existe).
    this.tenantContext.assertLocationAllowed(existing.locationId);

    // DX-271 (BE-039): los ítems de una cita cerrada o pasada no se cambian
    // (fijan el intervalo mínimo de la visita siguiente). El repositorio lo
    // vuelve a mirar con la fila bloqueada; aquí, antes de cualquier otra regla.
    if (
      patch.planItemIds !== undefined &&
      !planItemsEditable(
        existing,
        {
          status: patch.status ?? existing.status,
          start: patch.start ?? existing.start,
        },
        new Date(),
      )
    ) {
      throw new ConflictException(planItemsClosedMessage(existing, new Date()));
    }

    // DX-210: «Adelantar si hay hueco» lo cambian recepción, el odontólogo y
    // gestión (la asistente ve la agenda pero no la marca).
    const changesWantsEarlier =
      patch.wantsEarlier !== undefined &&
      patch.wantsEarlier !== existing.wantsEarlier;
    if (
      patch.wantsEarlier !== undefined &&
      !fromOpening &&
      auditContext &&
      !canChangeWantsEarlier(auditContext.actor.role)
    ) {
      throw new ForbiddenException(WANTS_EARLIER_FORBIDDEN_MESSAGE);
    }

    // DX-200: flujo del paciente en la clínica. La máquina de transiciones
    // decide (sin saltos imposibles, permisos por rol) y aquí se fijan las
    // horas con el reloj del servidor; el cambio va condicionado al estado
    // leído, así que dos personas a la vez no se pisan (la segunda, 409).
    const nextStatus =
      patch.status !== undefined && patch.status !== existing.status
        ? patch.status
        : null;
    const flowChange =
      nextStatus !== null &&
      (isInClinic(existing.status) || isInClinic(nextStatus));
    const flowPatch =
      nextStatus !== null
        ? await this.checkFlow(existing, nextStatus, auditContext, statusReason)
        : {};
    // DX-273: la salida de COMPLETED ya pasó rol y motivo; el repositorio
    // guarda el motivo, recalcula el mínimo de la visita siguiente y la
    // audita en la misma transacción.
    const completedExit =
      nextStatus !== null &&
      isCompletedExit(existing.status, nextStatus) &&
      auditContext
        ? { reason: normalizeStatusReason(statusReason)!, audit: auditContext }
        : undefined;

    // Reagendar = cambiar la hora O el profesional (DX-121: «Mover a…» y el
    // arrastre entre columnas). Ambos pasan por las mismas reglas.
    let warnings: Warnings = NO_WARNINGS;
    const isReschedule =
      patch.start !== undefined ||
      patch.end !== undefined ||
      (patch.providerId !== undefined &&
        patch.providerId !== existing.providerId);
    if (isReschedule) {
      const nextStart = patch.start ?? existing.start;
      const nextEnd = patch.end ?? existing.end;
      const nextProviderId = patch.providerId ?? existing.providerId;

      if (nextEnd <= nextStart) {
        throw new BadRequestException('End must be after start');
      }

      // DX-200: con el paciente en la clínica la cita sigue siendo de HOY:
      // moverla a otro día la dejaría «en curso» fuera de cualquier panel.
      // Cambiar de profesional o de hora dentro del día sí se puede.
      if (
        isInClinic(existing.status) &&
        !(await this.sameCivilDay(existing, nextStart))
      ) {
        throw new ConflictException(PATIENT_FLOW_MESSAGES.moveInClinic);
      }

      // No re-agendar hacia el pasado. Deliberadamente SOLO dentro de la rama
      // de reschedule: una cita que ya pasó se sigue pudiendo completar,
      // cancelar o editarle notas/motivo (patch sin start/end) — bloquear eso
      // haría imposible cerrar la agenda del día.
      if (nextStart.getTime() < Date.now()) {
        throw new BadRequestException(
          'No se puede reagendar una cita al pasado',
        );
      }

      if (nextProviderId !== existing.providerId) {
        const provider = await this.staff.findById(nextProviderId);
        if (!provider) {
          throw new NotFoundException('Profesional no encontrado');
        }
        // DX-121d: el profesional destino atiende en la sede de la cita.
        assertAttendsAt(provider, existing.locationId);
      }

      // Horario de atención de la SEDE DE LA CITA (no la del request: mover una
      // cita no la cambia de sede) — y también SOLO en la rama de reagendar:
      // una cita que quedó fuera de horario (p. ej. porque la clínica cambió su
      // horario después) se sigue pudiendo completar o cancelar. 422: la
      // petición es válida, pero el hueco no existe (DX-121).
      const hours = await this.schedule.findByLocation(existing.locationId);
      if (!fitsBusinessHours(nextStart, nextEnd, hours)) {
        throw new UnprocessableEntityException(
          businessHoursErrorMessage(nextStart, nextEnd, hours!),
        );
      }

      // DX-233: horario del profesional DESTINO en la sede de la cita; solo
      // al reagendar, como el de la sede.
      const offSchedule = await this.availability.warnOrReject({
        providerId: nextProviderId,
        locationId: existing.locationId,
        start: nextStart,
        end: nextEnd,
      });

      // DX-122: bloqueos del profesional DESTINO en la sede de la cita. Solo al
      // reagendar, como el horario: cancelar o completar una cita que quedó
      // dentro de un bloqueo creado después tiene que seguir siendo posible.
      warnings = collectWarnings(
        await checkScheduleBlocks(this.blocks, {
          providerId: nextProviderId,
          start: nextStart,
          end: nextEnd,
          locationId: existing.locationId,
        }),
        offSchedule,
      );

      // Re-check overlap EXCLUDING this appointment's own id — otherwise an
      // unchanged appointment would always "collide" with itself. Contra el
      // profesional DESTINO.
      const overlapping = await this.repo.findOverlapping(
        nextProviderId,
        nextStart,
        nextEnd,
        existing.id,
      );
      if (overlapping.length > 0) {
        throw new ConflictException(OVERLAP_MESSAGES.provider);
      }

      // Mismo criterio, otro eje: el paciente tampoco puede quedar con dos
      // citas solapadas al reagendar.
      const patientOverlapping = await this.repo.findOverlappingForPatient(
        existing.patientId,
        nextStart,
        nextEnd,
        existing.id,
      );
      if (patientOverlapping.length > 0) {
        throw new ConflictException(OVERLAP_MESSAGES.patient);
      }
    }

    // Race-proof backstop for the DB's EXCLUDE constraint
    // (appointments_no_overlap_per_provider / ..._per_patient, 23P01) — mirrors
    // CreateAppointmentUseCase. NOT limited to the reschedule branch on
    // purpose: the constraint's predicate is
    // `deletedAt IS NULL AND status <> 'CANCELLED'`, so UN-CANCELLING an
    // appointment (CANCELLED -> SCHEDULED) can also collide when its old slot
    // was taken meanwhile — and that path never runs the pre-check above.
    // Without this, either case would surface as a raw 500 instead of the 409
    // the pre-check produces. Es también lo que decide la carrera de dos
    // movimientos al mismo hueco (DX-121): uno escribe, el otro recibe 409.
    // DX-005: "confirmación pendiente" y "pide llamada" hablan de la cita tal
    // como era al enviar el enlace (que además deja de valer al reagendar o
    // cambiar el estado). Recepción que reagenda o cambia el estado a mano ya
    // atendió esa conversación, así que se limpian. Al reagendar, además, se
    // revocan los enlaces sin responder: cambiar SOLO de profesional no cambia
    // la hora, y el enlace seguiría vigente.
    const clearsConfirmation = isReschedule || patch.status !== undefined;
    // DX-122: cancelar o marcar no-show deja al paciente en «Pendientes por
    // agendar», en la MISMA transacción (el repo es idempotente por cita).
    const enqueuesWaitlist =
      patch.status !== undefined && WAITLIST_STATUSES.has(patch.status);
    // Y al revés (revisión H1): deja de estar cancelada o no-show → su entrada
    // OPEN se cierra con ella, en la misma transacción.
    const reactivates =
      patch.status !== undefined &&
      WAITLIST_STATUSES.has(existing.status) &&
      !WAITLIST_STATUSES.has(patch.status);
    const effectivePatch: UpdateAppointmentRepoInput = {
      ...patch,
      ...flowPatch,
      ...(clearsConfirmation
        ? { confirmationSentAt: null, callbackRequestedAt: null }
        : {}),
      ...(isReschedule ? { revokeConfirmations: true } : {}),
      ...(fromOpening ? { requireWantsEarlier: true } : {}),
      ...(completedExit ? { completedExit } : {}),
      ...(auditContext ? { audit: auditContext } : {}),
      ...(enqueuesWaitlist
        ? {
            enqueueWaitlist: {
              createdById: auditContext?.actor.userId ?? null,
            },
          }
        : {}),
      ...(reactivates
        ? {
            resolveWaitlist: {
              resolvedById: auditContext?.actor.userId ?? null,
            },
          }
        : {}),
    };

    let updated: Appointment;
    let waitlistEntryId: string | null;
    let reopenedWaitlistEntryId: string | null;
    let resolvedWaitlistEntryId: string | null;
    let exitResult: AppointmentWriteResult['completedExit'];
    try {
      ({
        appointment: updated,
        waitlistEntryId,
        reopenedWaitlistEntryId,
        resolvedWaitlistEntryId,
        completedExit: exitResult,
      } = await this.repo.update(id, effectivePatch));
    } catch (error) {
      const scope = overlapExclusionScope(error);
      if (scope !== null) {
        throw new ConflictException(OVERLAP_MESSAGES[scope]);
      }
      throw error;
    }

    if (isReschedule && auditContext) {
      await this.recordMove(existing, updated, auditContext);
    }
    if (flowChange && auditContext) {
      await this.recordStatus(
        updated,
        existing.status,
        'PATIENT_FLOW',
        auditContext,
      );
    }
    // El movimiento a un hueco ya deja su evento (la marca se apaga con él).
    if (changesWantsEarlier && !fromOpening && auditContext) {
      await this.recordWantsEarlier(updated, auditContext);
    }
    if (waitlistEntryId !== null && auditContext) {
      await this.recordWaitlistEntry(updated, waitlistEntryId, auditContext);
    }
    if (reopenedWaitlistEntryId !== null && auditContext) {
      await this.recordWaitlistEntry(
        updated,
        reopenedWaitlistEntryId,
        auditContext,
        'UPDATE',
        'WAITLIST_REOPENED',
      );
    }
    if (resolvedWaitlistEntryId !== null && auditContext) {
      await this.recordWaitlistEntry(
        updated,
        resolvedWaitlistEntryId,
        auditContext,
        'UPDATE',
        'APPOINTMENT_REACTIVATED',
      );
    }
    return {
      ...updated,
      ...warnings,
      planItemsReservedElsewhere: await this.reservedElsewhere(updated),
      ...(exitResult ? { completedExit: exitResult } : {}),
    };
  }

  /**
   * DX-273 «Traer a esta cita»: con el paciente en la clínica, la cita pasa
   * a reservar un tratamiento suyo que reservaba otra cita (que deja de
   * hacerlo). Transacción y auditoría en las dos citas, en el repositorio.
   */
  async claimPlanItem(
    id: string,
    planItemId: string,
    auditContext: AppointmentAuditContext,
  ): Promise<AppointmentWriteResult> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('Cita no encontrada');
    this.tenantContext.assertLocationAllowed(existing.locationId);
    if (!isInClinic(existing.status)) {
      throw new ConflictException(PLAN_ITEM_CLAIM_MESSAGES.notInClinic);
    }
    const { appointment } = await this.repo.claimPlanItem(
      id,
      planItemId,
      auditContext,
    );
    return {
      ...appointment,
      ...NO_WARNINGS,
      planItemsReservedElsewhere: await this.reservedElsewhere(appointment),
    };
  }

  /** DX-273: el aviso de la cita, salvo si ya no reserva nada. */
  private async reservedElsewhere(
    appointment: Appointment,
  ): Promise<PlanItemReservedElsewhere[]> {
    if (NOT_RESERVING.has(appointment.status)) return [];
    const byAppointment = await this.repo.findPlanItemsReservedElsewhere([
      appointment.id,
    ]);
    return byAppointment.get(appointment.id) ?? [];
  }

  /**
   * DX-200 «Deshacer llegada»: el paciente marcado como llegado por error
   * vuelve al estado que tenía (agendada o confirmada) y se borra la hora de
   * llegada. Solo desde «En espera» (ARRIVED) y solo el mostrador; queda en
   * auditoría. Condicional: si otra persona lo movió mientras tanto, 409.
   */
  async undoArrival(
    id: string,
    auditContext: AppointmentAuditContext,
  ): Promise<AppointmentWriteResult> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('Cita no encontrada');
    this.tenantContext.assertLocationAllowed(existing.locationId);
    const role = auditContext.actor.role;
    if (role === null || !FRONT_DESK_ROLES.includes(role)) {
      throw new ForbiddenException(PATIENT_FLOW_MESSAGES.arriveForbidden);
    }
    if (existing.status !== AppointmentStatus.ARRIVED) {
      throw new ConflictException(PATIENT_FLOW_MESSAGES.undoNotArrived);
    }
    const updated = await this.repo.undoArrival(id);
    if (!updated) throw new ConflictException(PATIENT_FLOW_MESSAGES.stale);
    await this.recordStatus(
      updated,
      AppointmentStatus.ARRIVED,
      'ARRIVAL_UNDONE',
      auditContext,
    );
    return {
      ...updated,
      ...NO_WARNINGS,
      planItemsReservedElsewhere: await this.reservedElsewhere(updated),
    };
  }

  /**
   * Valida el cambio de estado con la máquina del flujo (DX-200) y devuelve lo
   * que el repositorio tiene que escribir además del estado: la hora del paso,
   * a qué vuelve «Deshacer llegada» y la condición sobre el estado leído.
   */
  private async checkFlow(
    existing: Appointment,
    to: AppointmentStatus,
    auditContext: AppointmentAuditContext | undefined,
    statusReason?: string | null,
  ): Promise<Partial<UpdateAppointmentRepoInput>> {
    const from = existing.status;
    const isToday =
      to === AppointmentStatus.ARRIVED ? await this.isToday(existing) : true;
    const verdict = checkStatusTransition({
      from,
      to,
      role: auditContext?.actor.role ?? null,
      isToday,
      arrived: existing.arrivedAt !== null,
      statusReason,
    });
    if (!verdict.ok) {
      if (verdict.kind === 'FORBIDDEN')
        throw new ForbiddenException(verdict.message);
      if (verdict.kind === 'BAD_REQUEST')
        throw new BadRequestException(verdict.message);
      throw new ConflictException(verdict.message);
    }
    if (!isInClinic(from) && !isInClinic(to)) {
      // Vuelve a estar pendiente (p. ej. se reactiva una cita que se canceló
      // tras llegar): sin horas de una visita que ya no está en curso.
      const pending =
        to === AppointmentStatus.SCHEDULED ||
        to === AppointmentStatus.CONFIRMED;
      const hasTimes =
        existing.arrivedAt !== null ||
        existing.seatedAt !== null ||
        existing.readyForCheckoutAt !== null;
      // También condicionado al estado leído: si mientras tanto alguien marcó
      // «Llegó», cancelar o marcar no-show sobre lo leído no lo pisa (409).
      return pending && hasTimes
        ? {
            expectStatus: from,
            arrivedAt: null,
            seatedAt: null,
            readyForCheckoutAt: null,
          }
        : { expectStatus: from };
    }
    const now = new Date();
    return {
      expectStatus: from,
      ...(isInClinic(to) ? { [FLOW_TIMESTAMP_FIELD[to]]: now } : {}),
      // La vuelta de «Deshacer llegada» solo existe mientras está en espera.
      preArrivalStatus: to === AppointmentStatus.ARRIVED ? from : null,
    };
  }

  /** ¿La cita es de hoy en la zona de su sede (reloj del servidor)? */
  private isToday(appointment: Appointment): Promise<boolean> {
    return this.sameCivilDay(appointment, new Date());
  }

  /** ¿`instant` cae en el mismo día civil que la cita, en la zona de su sede? */
  private async sameCivilDay(
    appointment: Appointment,
    instant: Date,
  ): Promise<boolean> {
    const location = await this.locations.findById(appointment.locationId);
    if (!location) throw new NotFoundException('Sede no encontrada');
    return (
      civilDateIn(appointment.start, location.timeZone) ===
      civilDateIn(instant, location.timeZone)
    );
  }

  /** `audit_event` de un paso del flujo en la clínica (DX-200). */
  private recordStatus(
    appointment: Appointment,
    from: AppointmentStatus,
    reason: 'PATIENT_FLOW' | 'ARRIVAL_UNDONE',
    ctx: AppointmentAuditContext,
  ): Promise<void> {
    return this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'UPDATE',
      resourceType: 'APPOINTMENT',
      resourceId: appointment.id,
      patient: { kind: 'patient', id: appointment.patientId },
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason, status: { from, to: appointment.status } },
    });
  }

  /**
   * `audit_event` del alta automática en «Pendientes por agendar» (DX-122),
   * de su cierre al reactivar la cita (revisión H1) o de su reapertura si la
   * cita vuelve a cancelarse.
   */
  private recordWaitlistEntry(
    appointment: Appointment,
    entryId: string,
    ctx: AppointmentAuditContext,
    action: 'CREATE' | 'UPDATE' = 'CREATE',
    reason = 'WAITLIST_FROM_APPOINTMENT',
  ): Promise<void> {
    return this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action,
      resourceType: 'WAITLIST_ENTRY',
      resourceId: entryId,
      patient: { kind: 'patient', id: appointment.patientId },
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason },
    });
  }

  /** `audit_event` de marcar o desmarcar «Adelantar si hay hueco» (DX-210). */
  private recordWantsEarlier(
    appointment: Appointment,
    ctx: AppointmentAuditContext,
  ): Promise<void> {
    return this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'UPDATE',
      resourceType: 'APPOINTMENT',
      resourceId: appointment.id,
      patient: { kind: 'patient', id: appointment.patientId },
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        reason: appointment.wantsEarlier
          ? 'WANTS_EARLIER_ON'
          : 'WANTS_EARLIER_OFF',
      },
    });
  }

  /** `audit_event` del movimiento: hora y profesional antes y después. */
  private recordMove(
    before: Appointment,
    after: Appointment,
    ctx: AppointmentAuditContext,
  ): Promise<void> {
    return this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'UPDATE',
      resourceType: 'APPOINTMENT',
      resourceId: before.id,
      patient: { kind: 'patient', id: before.patientId },
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        reason: 'APPOINTMENT_MOVED',
        move: {
          from: {
            start: before.start.toISOString(),
            end: before.end.toISOString(),
            providerId: before.providerId,
          },
          to: {
            start: after.start.toISOString(),
            end: after.end.toISOString(),
            providerId: after.providerId,
          },
        },
      },
    });
  }
}
