import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { APPOINTMENT_REPOSITORY } from '../../domain/ports/appointment-repository.port';
import type { AppointmentRepository } from '../../domain/ports/appointment-repository.port';
import { Appointment } from '../../domain/entities/appointment.entity';
import {
  OVERLAP_MESSAGES,
  overlapExclusionScope,
} from '../appointment-overlap-error';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { LOCATION_SCHEDULE_REPOSITORY } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import type { LocationScheduleRepository } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import {
  businessHoursErrorMessage,
  fitsBusinessHours,
} from '../../../location-schedule/application/business-hours';
import { STAFF_REPOSITORY } from '../../../staff/domain/ports/staff-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';

// NOTE: deliberately NO `tenantId`/`status` field — tenant comes from the
// guarded request context (the repository reads it, never this input), and
// a newly created appointment always starts SCHEDULED (the schema default).
export interface CreateAppointmentInput {
  patientId: string;
  providerId: string;
  start: Date;
  end: Date;
  reason?: string;
  notes?: string;
  createdById?: string;
}

@Injectable()
export class CreateAppointmentUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly repo: AppointmentRepository,
    // Se inyectan (no se re-implementan) para resolver "¿este paciente y este
    // profesional son de ESTA clínica?" — mismo patrón cross-module que
    // AddTreatmentPlanItemUseCase inyectando DENTAL_CATALOG_REPOSITORY.
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
    @Inject(STAFF_REPOSITORY)
    private readonly staff: StaffRepository,
    @Inject(LOCATION_SCHEDULE_REPOSITORY)
    private readonly schedule: LocationScheduleRepository,
  ) {}

  async execute(input: CreateAppointmentInput): Promise<Appointment> {
    if (input.end <= input.start) {
      throw new BadRequestException('End must be after start');
    }

    // No agendar en el pasado: una cita nueva siempre es a futuro. Se compara
    // el INSTANTE (no solo la fecha), así que "hoy a una hora ya pasada" también
    // se rechaza — que es el caso que más se cuela por un `<input type="date">`
    // sin `min`. `start === now` se permite (solo se rechaza estrictamente
    // anterior), para no fallar por el segundo que tarda el submit en llegar.
    // Nota: esto aplica a CREAR; registrar/cerrar una cita YA pasada se hace
    // cambiando su estado (ver UpdateAppointmentUseCase, que solo valida el
    // pasado cuando se re-agenda).
    if (input.start.getTime() < Date.now()) {
      throw new BadRequestException(
        'No se puede agendar una cita en el pasado',
      );
    }

    // `patientId` y `providerId` tienen que resolver a entidades REALES de ESTA
    // clínica, antes de mirar solapes (un id inválido hace que el solape no
    // signifique nada). Ambos repos filtran por tenant vía RLS, así que un
    // paciente/profesional de otro tenant devuelve null igual que uno inexistente.
    //
    // Por qué importa: `patientId` solo tenía una FK a `patients(id)`, que NO
    // valida el tenant (las FK de Postgres se chequean saltando la RLS), así que
    // se podía agendar contra un paciente de OTRA clínica. Y `providerId` no
    // tenía ninguna validación: cualquier UUID pasaba como "profesional".
    const patient = await this.patients.findById(input.patientId);
    if (!patient) {
      throw new NotFoundException('Paciente no encontrado');
    }
    const provider = await this.staff.findById(input.providerId);
    if (!provider) {
      throw new NotFoundException('Profesional no encontrado');
    }

    // Horario de atención de la SEDE: la cita tiene que caber completa en un
    // tramo del día. Sede sin horario configurado => sin restricción (ver
    // fitsBusinessHours), así que esto no cambia nada hasta que la clínica lo
    // configure. Se lee la sede EN CONTEXTO, la misma en la que el repo escribirá
    // la cita.
    const hours = await this.schedule.findForCurrentLocation();
    if (!fitsBusinessHours(input.start, input.end, hours)) {
      throw new BadRequestException(
        businessHoursErrorMessage(input.start, input.end, hours!),
      );
    }

    // Overlap rule: two half-open intervals [s1,e1) and [s2,e2) overlap iff
    // s1 < e2 AND s2 < e1 — enforced by the repository's findOverlapping
    // query. A CANCELLED appointment never blocks (repo excludes it).
    const overlapping = await this.repo.findOverlapping(
      input.providerId,
      input.start,
      input.end,
    );
    if (overlapping.length > 0) {
      throw new ConflictException(OVERLAP_MESSAGES.provider);
    }

    // Mismo criterio, otro eje: el PACIENTE tampoco puede estar en dos citas a
    // la vez (aunque sean con profesionales distintos — no puede estar en dos
    // sillones). Antes solo se validaba el solape del profesional.
    const patientOverlapping = await this.repo.findOverlappingForPatient(
      input.patientId,
      input.start,
      input.end,
    );
    if (patientOverlapping.length > 0) {
      throw new ConflictException(OVERLAP_MESSAGES.patient);
    }

    // The pre-checks above handle the common case with a friendly 409 WITHOUT
    // hitting the DB. This try/catch is the race-proof backstop: if a
    // concurrent create slips past them, the DB's EXCLUDE constraints
    // (appointments_no_overlap_per_provider / ..._per_patient, SQLSTATE 23P01)
    // reject the INSERT — se mapea al MISMO 409 del pre-check correspondiente.
    try {
      return await this.repo.create({
        patientId: input.patientId,
        providerId: input.providerId,
        start: input.start,
        end: input.end,
        reason: input.reason,
        notes: input.notes,
        createdById: input.createdById,
      });
    } catch (error) {
      const scope = overlapExclusionScope(error);
      if (scope !== null) {
        throw new ConflictException(OVERLAP_MESSAGES[scope]);
      }
      throw error;
    }
  }
}
