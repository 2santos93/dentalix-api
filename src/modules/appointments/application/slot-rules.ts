import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ClinicRole } from '@prisma/client';
import type { Appointment } from '../domain/entities/appointment.entity';
import type { AppointmentRepository } from '../domain/ports/appointment-repository.port';
import { PATIENT_FLOW_MESSAGES, isInClinic } from '../domain/patient-flow';
import {
  checkScheduleBlocks,
  type ReservedOverride,
} from './schedule-block-check';
import { overlapConflict } from './appointment-overlap-error';
import { collectWarnings, type Warnings } from './appointment-warnings';
import type { ScheduleBlockRepository } from '../../schedule-blocks/domain/ports/schedule-block-repository.port';
import type { ScheduleBlockClock } from '../../schedule-blocks/application/schedule-block-clock';
import type { LocationScheduleRepository } from '../../location-schedule/domain/ports/location-schedule-repository.port';
import {
  businessHoursErrorMessage,
  fitsBusinessHours,
} from '../../location-schedule/application/business-hours';
import type { StaffRepository } from '../../staff/domain/ports/staff-repository.port';
import type { LocationRepository } from '../../locations/domain/ports/location-repository.port';
import { assertAttendsAt } from '../../staff/domain/provider-location';
import { assertAttendingRole } from '../../staff/domain/attending';
import {
  PROVIDER_OFF_SCHEDULE,
  type ProviderAvailabilityService,
  type ScheduleWarning,
} from '../../provider-schedule/application/provider-availability.service';
import { civilDateIn } from '../../../shared/time/civil-day';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import { assertLocationWritable } from '../../../shared/tenancy/active-location';

/**
 * DX-267-bis (BE-039): código del 409 al reactivar una cita que ya terminó.
 * Con él la web podrá ofrecer «Agendar una nueva» sin leer el texto.
 */
export const APPOINTMENT_PAST_CODE = 'APPOINTMENT_PAST';
export const APPOINTMENT_PAST_MESSAGE = 'La cita ya pasó: agenda una nueva';

/**
 * Para qué se miran las reglas del hueco:
 * - `move`: la cita cambia de hora o de profesional (DX-121, «Mover a…»).
 * - `reactivate`: una cita CANCELLED o NO_SHOW vuelve a SCHEDULED/CONFIRMED
 *   en su misma hora y con su mismo profesional (DX-267-bis): es «moverla a
 *   donde estaba», así que se mira todo lo que pudo cambiar desde que se
 *   canceló (sede, profesional, horarios, bloqueos, otras citas).
 */
export type SlotRulesMode = 'move' | 'reactivate';

export interface SlotRulesDeps {
  locations: LocationRepository;
  schedule: LocationScheduleRepository;
  staff: StaffRepository;
  availability: ProviderAvailabilityService;
  blocks: ScheduleBlockRepository;
  repo: Pick<
    AppointmentRepository,
    'findOverlapping' | 'findOverlappingForPatient'
  >;
  /** Reloj inyectable del caso de uso (hueco reservado y «ya pasó»). */
  clock: ScheduleBlockClock;
}

export interface SlotRulesInput {
  mode: SlotRulesMode;
  /** La cita tal como está guardada. */
  appointment: Appointment;
  /** Destino: el de mover, o el de la propia cita al reactivar. */
  providerId: string;
  start: Date;
  end: Date;
  /** Rol de quien mueve o reactiva (`null` = sin usuario). */
  actorRole: ClinicRole | null;
  /** DX-446: «Mover igualmente» a un hueco reservado. */
  overrideReason?: string;
  /**
   * Revisar el profesional aunque no cambie: la cita sale de CANCELLED o
   * NO_SHOW (reactivar y mover a la vez). Mientras estuvo cancelada pudo
   * dejar la clínica, la sede o su rol; sin esto, moverla 5 minutos al
   * reactivarla se saltaría esa comprobación. Al reactivar sin mover se
   * revisa siempre.
   */
  revalidateProvider?: boolean;
}

export interface SlotRulesResult extends Warnings {
  reservedOverride: ReservedOverride | null;
}

/** ¿`instant` cae en el mismo día civil que la cita, en la zona de su sede? */
export async function sameCivilDay(
  locations: LocationRepository,
  appointment: Appointment,
  instant: Date,
): Promise<boolean> {
  const location = await locations.findById(appointment.locationId);
  if (!location) throw new NotFoundException('Sede no encontrada');
  const timeZone = requireLocationTimeZone(location);
  return (
    civilDateIn(appointment.start, timeZone) === civilDateIn(instant, timeZone)
  );
}

/** 409 de reactivar una cita que ya terminó (DX-267-bis). */
export function appointmentPastConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: APPOINTMENT_PAST_CODE,
    message: APPOINTMENT_PAST_MESSAGE,
  });
}

/**
 * Reglas de un hueco al mover o reactivar una cita (una sola función para los
 * dos, DX-267-bis). Lanza el primer error en este orden:
 *
 * 1. SEC-014: la sede desactivada no recibe horas.
 * 2. (mover) fin > inicio; con el paciente en la clínica, el mismo día civil.
 * 3. Pasado (reloj inyectable `deps.clock`): mover a una hora que ya empezó
 *    → 400; reactivar una cita que ya terminó (`end <= reloj`) → 409
 *    `APPOINTMENT_PAST`. Reactivar mientras
 *    dura (llegó tarde tras «No asistió», urgencia en curso) sí se puede.
 * 4. Profesional de la clínica, que atiende en la sede y atiende pacientes:
 *    al mover solo si cambia (o si la cita sale de CANCELLED/NO_SHOW,
 *    `revalidateProvider`); al reactivar siempre (pudo cambiar desde que se
 *    canceló).
 * 5. Horario de la sede (422).
 * 6. Horario del profesional: aviso, o 409 en modo estricto.
 * 7. Bloqueos (409 / aviso) y hueco reservado (DX-446, `overrideReason`).
 * 8. Solape del profesional y 9. del paciente (409 `APPOINTMENT_OVERLAP`).
 *
 * Una urgencia (`walkIn`) que se reactiva tiene las excepciones de su alta
 * (`CreateWalkInUseCase`): sin horario de la sede, y el del profesional solo
 * avisa, también en estricto. Un sobrecupo que se reactiva no pasa por el
 * solape del profesional: eso lo decide `overbookAtItsSlot` (DX-509).
 */
export async function checkSlotRules(
  deps: SlotRulesDeps,
  input: SlotRulesInput,
): Promise<SlotRulesResult> {
  const { mode, appointment: existing, providerId, start, end } = input;
  const reactivating = mode === 'reactivate';
  const walkInRules = reactivating && existing.walkIn;

  // SEC-014: una sede desactivada no recibe horas nuevas. Solo al reagendar
  // o reactivar: cancelar, completar o editar notas siguen abiertos para
  // poder cerrar la agenda de la sede.
  const site = await deps.locations.findById(existing.locationId);
  if (site) assertLocationWritable(site);

  if (!reactivating) {
    if (end <= start) {
      throw new BadRequestException('End must be after start');
    }

    // DX-200: con el paciente en la clínica la cita sigue siendo de HOY:
    // moverla a otro día la dejaría «en curso» fuera de cualquier panel.
    // Cambiar de profesional o de hora dentro del día sí se puede.
    if (
      isInClinic(existing.status) &&
      !(await sameCivilDay(deps.locations, existing, start))
    ) {
      throw new ConflictException(PATIENT_FLOW_MESSAGES.moveInClinic);
    }

    // No re-agendar hacia el pasado. Deliberadamente SOLO al mover o
    // reactivar: una cita que ya pasó se sigue pudiendo completar, cancelar
    // o editarle notas/motivo — bloquear eso haría imposible cerrar la agenda
    // del día. Con el reloj inyectable del caso de uso, el mismo que decide
    // «ya pasó» al reactivar (en producción, la hora del sistema).
    if (start.getTime() < deps.clock().getTime()) {
      throw new BadRequestException('No se puede reagendar una cita al pasado');
    }
  } else if (end.getTime() <= deps.clock().getTime()) {
    throw appointmentPastConflict();
  }

  if (
    reactivating ||
    input.revalidateProvider === true ||
    providerId !== existing.providerId
  ) {
    const provider = await deps.staff.findById(providerId);
    if (!provider) {
      throw new NotFoundException('Profesional no encontrado');
    }
    // DX-121d: el profesional atiende en la sede de la cita.
    assertAttendsAt(provider, existing.locationId);
    // DX-161: y atiende pacientes (no recepción ni asistencia).
    assertAttendingRole(provider);
  }

  // Horario de atención de la SEDE DE LA CITA (no la del request: mover una
  // cita no la cambia de sede). Una cita que quedó fuera de horario (p. ej.
  // porque la clínica cambió su horario después) se sigue pudiendo completar
  // o cancelar. 422: la petición es válida, pero el hueco no existe (DX-121).
  if (!walkInRules) {
    const hours = await deps.schedule.findByLocation(existing.locationId);
    if (!fitsBusinessHours(start, end, hours)) {
      // DX-354: formato y reloj de la sede de la cita, pedido solo si el
      // mensaje lleva horas.
      const source = await deps.schedule.formatSourceOf(existing.locationId);
      throw new UnprocessableEntityException(
        businessHoursErrorMessage(start, end, hours!, () =>
          requireLocationFormat(source),
        ),
      );
    }
  }

  // DX-233: horario del profesional en la sede de la cita.
  const slot = { providerId, locationId: existing.locationId, start, end };
  let offSchedule: ScheduleWarning | null;
  if (walkInRules) {
    const message = await deps.availability.offScheduleMessage(slot);
    offSchedule =
      message === null ? null : { code: PROVIDER_OFF_SCHEDULE, message };
  } else {
    offSchedule = await deps.availability.warnOrReject(slot);
  }

  // DX-122: bloqueos del profesional en la sede de la cita. Cancelar o
  // completar una cita que quedó dentro de un bloqueo creado después tiene
  // que seguir siendo posible: por eso solo al mover o reactivar.
  // DX-446: con el tipo de la cita, el reloj y el rol de quien mueve.
  const blockCheck = await checkScheduleBlocks(
    deps.blocks,
    { providerId, start, end, locationId: existing.locationId },
    {
      appointmentTypeId: existing.appointmentTypeId,
      now: deps.clock(),
      actorRole: input.actorRole,
      overrideReason: input.overrideReason,
    },
  );

  // Re-check overlap EXCLUDING this appointment's own id — otherwise an
  // unchanged appointment would always "collide" with itself. Contra el
  // profesional DESTINO. DX-509: un sobrecupo reactivado lo decide
  // `overbookAtItsSlot` (409 `OVERBOOK_SLOT_TAKEN` con `canKeepOverbooked`).
  if (!(reactivating && existing.overbooked)) {
    const overlapping = await deps.repo.findOverlapping(
      providerId,
      start,
      end,
      existing.id,
    );
    if (overlapping.length > 0) {
      throw overlapConflict('provider');
    }
  }

  // Mismo criterio, otro eje: el paciente tampoco puede quedar con dos
  // citas solapadas.
  const patientOverlapping = await deps.repo.findOverlappingForPatient(
    existing.patientId,
    start,
    end,
    existing.id,
  );
  if (patientOverlapping.length > 0) {
    throw overlapConflict('patient');
  }

  return {
    ...collectWarnings(blockCheck.warnings, offSchedule),
    reservedOverride: blockCheck.override,
  };
}
