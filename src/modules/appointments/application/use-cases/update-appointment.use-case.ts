import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ClinicRole } from '@prisma/client';
import { APPOINTMENT_REPOSITORY } from '../../domain/ports/appointment-repository.port';
import type {
  AppointmentRepository,
  UpdateAppointmentRepoInput,
} from '../../domain/ports/appointment-repository.port';
import { Appointment } from '../../domain/entities/appointment.entity';
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
  'revokeConfirmations'
>;

/**
 * Quién mueve la cita y desde dónde (DX-121): con esto el use-case deja el
 * `audit_event` del movimiento, que necesita la hora y el profesional ANTES del
 * cambio — algo que el AuditInterceptor, que solo ve la respuesta, no tiene.
 */
export interface AppointmentAuditContext {
  tenantId: string;
  locationId: string | null;
  actor: { userId: string; role: ClinicRole | null };
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}

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
  ) {}

  async execute(
    id: string,
    patch: UpdateAppointmentInput,
    auditContext?: AppointmentAuditContext,
  ): Promise<Appointment> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      // Same rationale as the Patient use cases: a missing row and a row
      // that belongs to another tenant are indistinguishable here (RLS
      // makes cross-tenant rows invisible), so both surface as NotFound.
      throw new NotFoundException('Appointment not found');
    }

    // Reagendar = cambiar la hora O el profesional (DX-121: «Mover a…» y el
    // arrastre entre columnas). Ambos pasan por las mismas reglas.
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
    const effectivePatch: UpdateAppointmentRepoInput = clearsConfirmation
      ? {
          ...patch,
          confirmationSentAt: null,
          callbackRequestedAt: null,
          ...(isReschedule ? { revokeConfirmations: true } : {}),
        }
      : patch;

    let updated: Appointment;
    try {
      updated = await this.repo.update(id, effectivePatch);
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
    return updated;
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
