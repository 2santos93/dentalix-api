import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
import {
  OVERLAP_MESSAGES,
  overlapExclusionScope,
} from '../appointment-overlap-error';

export type UpdateAppointmentInput = UpdateAppointmentRepoInput;

@Injectable()
export class UpdateAppointmentUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly repo: AppointmentRepository,
    @Inject(LOCATION_SCHEDULE_REPOSITORY)
    private readonly schedule: LocationScheduleRepository,
  ) {}

  async execute(
    id: string,
    patch: UpdateAppointmentInput,
  ): Promise<Appointment> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      // Same rationale as the Patient use cases: a missing row and a row
      // that belongs to another tenant are indistinguishable here (RLS
      // makes cross-tenant rows invisible), so both surface as NotFound.
      throw new NotFoundException('Appointment not found');
    }

    const isReschedule = patch.start !== undefined || patch.end !== undefined;
    if (isReschedule) {
      const nextStart = patch.start ?? existing.start;
      const nextEnd = patch.end ?? existing.end;

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

      // Horario de atención, igual que en Create — y también SOLO en la rama de
      // reagendar: una cita que quedó fuera de horario (p. ej. porque la clínica
      // cambió su horario después) se sigue pudiendo completar o cancelar.
      const hours = await this.schedule.findForCurrentLocation();
      if (!fitsBusinessHours(nextStart, nextEnd, hours)) {
        throw new BadRequestException(
          businessHoursErrorMessage(nextStart, nextEnd, hours!),
        );
      }

      // Re-check overlap EXCLUDING this appointment's own id — otherwise an
      // unchanged appointment would always "collide" with itself.
      const overlapping = await this.repo.findOverlapping(
        existing.providerId,
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
    // the pre-check produces.
    try {
      return await this.repo.update(id, patch);
    } catch (error) {
      const scope = overlapExclusionScope(error);
      if (scope !== null) {
        throw new ConflictException(OVERLAP_MESSAGES[scope]);
      }
      throw error;
    }
  }
}
