import {
  BadRequestException,
  ConflictException,
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

/**
 * Lo que el cliente puede cambiar. `revokeConfirmations` y los indicadores de
 * confirmación NO: los decide este use-case.
 */
export type UpdateAppointmentInput = Omit<
  UpdateAppointmentRepoInput,
  'revokeConfirmations' | 'enqueueWaitlist'
>;

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
  ) {}

  async execute(
    id: string,
    patch: UpdateAppointmentInput,
    auditContext?: AppointmentAuditContext,
  ): Promise<AppointmentWriteResult> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      // Same rationale as the Patient use cases: a missing row and a row
      // that belongs to another tenant are indistinguishable here (RLS
      // makes cross-tenant rows invisible), so both surface as NotFound.
      throw new NotFoundException('Appointment not found');
    }

    // Reagendar = cambiar la hora O el profesional (DX-121: «Mover a…» y el
    // arrastre entre columnas). Ambos pasan por las mismas reglas.
    let warnings: string[] = [];
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

      // DX-122: bloqueos del profesional DESTINO en la sede de la cita. Solo al
      // reagendar, como el horario: cancelar o completar una cita que quedó
      // dentro de un bloqueo creado después tiene que seguir siendo posible.
      warnings = await checkScheduleBlocks(this.blocks, {
        providerId: nextProviderId,
        start: nextStart,
        end: nextEnd,
        locationId: existing.locationId,
      });

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
    const effectivePatch: UpdateAppointmentRepoInput = {
      ...patch,
      ...(clearsConfirmation
        ? { confirmationSentAt: null, callbackRequestedAt: null }
        : {}),
      ...(isReschedule ? { revokeConfirmations: true } : {}),
      ...(enqueuesWaitlist
        ? {
            enqueueWaitlist: {
              createdById: auditContext?.actor.userId ?? null,
            },
          }
        : {}),
    };

    let updated: Appointment;
    let waitlistEntryId: string | null;
    try {
      ({ appointment: updated, waitlistEntryId } = await this.repo.update(
        id,
        effectivePatch,
      ));
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
    if (waitlistEntryId !== null && auditContext) {
      await this.recordWaitlistEntry(updated, waitlistEntryId, auditContext);
    }
    return { ...updated, warnings };
  }

  /** `audit_event` del alta automática en «Pendientes por agendar» (DX-122). */
  private recordWaitlistEntry(
    appointment: Appointment,
    entryId: string,
    ctx: AppointmentAuditContext,
  ): Promise<void> {
    return this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'CREATE',
      resourceType: 'WAITLIST_ENTRY',
      resourceId: entryId,
      patient: { kind: 'patient', id: appointment.patientId },
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: 'WAITLIST_FROM_APPOINTMENT' },
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
