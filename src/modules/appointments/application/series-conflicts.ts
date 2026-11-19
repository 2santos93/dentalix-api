import { AppointmentStatus } from '@prisma/client';
import { ConflictException, HttpException } from '@nestjs/common';
import type { SlotRuleFailure, SlotRuleStep } from './slot-rule-failure';
import { RESERVED_SLOT_CODE } from './schedule-block-check';

/**
 * DX-562: por qué una fecha de una serie no se puede agendar (o mover). Código
 * estable para la web y el texto en español de la regla, el MISMO que daría
 * la cita suelta.
 */
export const SERIES_CONFLICT_CODES = [
  'PAST',
  'BUSINESS_HOURS',
  'LOCATION_HOLIDAY',
  'PROVIDER_OFF_SCHEDULE',
  'SCHEDULE_BLOCKED',
  'RESERVED_SLOT',
  'PROVIDER_OVERLAP',
  'PATIENT_OVERLAP',
  'CHAIR_OVERLAP',
  'SERIES_OVERLAP',
] as const;
export type SeriesConflictCode = (typeof SERIES_CONFLICT_CODES)[number];

export interface SeriesConflictReason {
  code: SeriesConflictCode;
  message: string;
  /** Solo en `LOCATION_HOLIDAY`: el día civil y el nombre del festivo. */
  holiday?: { date: string; name: string };
}

export const APPOINTMENT_SERIES_CONFLICT_CODE = 'APPOINTMENT_SERIES_CONFLICT';
/** DX-562: alguna cita cambió entre la lectura y la escritura (mover/cancelar). */
export const APPOINTMENT_SERIES_STALE_CODE = 'APPOINTMENT_SERIES_STALE';

export const SERIES_MESSAGES = {
  conflict:
    'Algunas fechas de la serie ya no están libres. Revisa la vista previa y ajústalas u omítelas.',
  seriesOverlap: 'Choca con otra cita de la misma serie.',
  notFound: 'Serie no encontrada',
  notInSeries: 'La cita no es de esta serie.',
  pivotNotMovable:
    'Esa cita ya no se puede mover (ya pasó, está en curso, atendida o cancelada): elige una cita pendiente de la serie.',
  nothingToMove:
    'No hay citas pendientes de la serie desde esa cita para mover.',
  sameStart: 'La cita ya está a esa hora.',
  differentLocations:
    'Las citas de la serie están en sedes distintas: muévelas una a una.',
  stale:
    'Alguna cita de la serie cambió mientras tanto (otra persona la movió, la canceló o la atendió). Vuelve a abrir la serie y repite el cambio.',
  offPattern: (weeks: number) =>
    `Cada fecha tiene que caer en uno de los días de la serie (cada ${weeks === 1 ? 'semana' : `${weeks} semanas`} desde la primera cita). Para otro día, agenda una cita aparte.`,
  sameDay: 'Hay dos fechas para el mismo día de la serie.',
  busy: 'Otra persona estaba agendando a la vez y no se pudo terminar. Vuelve a intentarlo.',
} as const;

const STEP_CODE: Record<SlotRuleStep, SeriesConflictCode> = {
  PAST: 'PAST',
  BUSINESS_HOURS: 'BUSINESS_HOURS',
  LOCATION_HOLIDAY: 'LOCATION_HOLIDAY',
  PROVIDER_OFF_SCHEDULE: 'PROVIDER_OFF_SCHEDULE',
  SCHEDULE_BLOCK: 'SCHEDULE_BLOCKED',
  PROVIDER_OVERLAP: 'PROVIDER_OVERLAP',
  PATIENT_OVERLAP: 'PATIENT_OVERLAP',
  CHAIR_OVERLAP: 'CHAIR_OVERLAP',
};

/** El cuerpo de una excepción HTTP: su `message` (texto) y sus extras. */
function bodyOf(error: HttpException): Record<string, unknown> {
  const response = error.getResponse();
  return typeof response === 'string'
    ? { message: response }
    : (response as Record<string, unknown>);
}

function messageOf(body: Record<string, unknown>, fallback: string): string {
  const { message } = body;
  if (typeof message === 'string') return message;
  if (Array.isArray(message) && typeof message[0] === 'string') {
    return message[0];
  }
  return fallback;
}

/** La razón de una regla que falló, con el texto de la cita suelta. */
export function reasonFromFailure(
  failure: SlotRuleFailure,
): SeriesConflictReason {
  const body = bodyOf(failure.error);
  const message = messageOf(body, failure.error.message);
  if (failure.step === 'SCHEDULE_BLOCK' && body.code === RESERVED_SLOT_CODE) {
    return { code: 'RESERVED_SLOT', message };
  }
  if (failure.step === 'LOCATION_HOLIDAY') {
    const holiday = body.holiday as { date?: unknown; name?: unknown };
    if (
      holiday &&
      typeof holiday.date === 'string' &&
      typeof holiday.name === 'string'
    ) {
      return {
        code: 'LOCATION_HOLIDAY',
        message,
        holiday: { date: holiday.date, name: holiday.name },
      };
    }
  }
  return { code: STEP_CODE[failure.step], message };
}

/** Una fecha de la serie que choca: su posición, su franja y por qué. */
export interface SeriesConflict {
  index: number;
  /** Al mover: la cita de la serie que choca. */
  appointmentId?: string;
  start: Date;
  end: Date;
  reasons: SeriesConflictReason[];
}

/** 409 `APPOINTMENT_SERIES_CONFLICT` con TODAS las fechas que chocan. */
export function seriesConflict(
  conflicts: readonly SeriesConflict[],
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: APPOINTMENT_SERIES_CONFLICT_CODE,
    message: SERIES_MESSAGES.conflict,
    conflicts: conflicts.map((c) => ({
      index: c.index,
      ...(c.appointmentId ? { appointmentId: c.appointmentId } : {}),
      start: c.start.toISOString(),
      end: c.end.toISOString(),
      reasons: c.reasons,
    })),
  });
}

/** Estados en los que una cita de la serie sigue pendiente (DX-562 D5/D6). */
export const SERIES_PENDING_STATUSES: readonly AppointmentStatus[] = [
  AppointmentStatus.SCHEDULED,
  AppointmentStatus.CONFIRMED,
];

/**
 * DX-562 (D5/D6): «esta y las siguientes». De las citas de la serie, las de
 * posición ≥ la del pivote que siguen pendientes (agendada o confirmada) y
 * todavía no empezaron: nunca las atendidas, en clínica, canceladas, no
 * asistidas, retiradas ni anteriores. En orden de posición.
 */
export function followingAppointments<
  T extends {
    status: AppointmentStatus;
    start: Date;
    series?: { index: number };
  },
>(appointments: readonly T[], pivotIndex: number, now: Date): T[] {
  return appointments
    .filter(
      (a) =>
        a.series !== undefined &&
        a.series.index >= pivotIndex &&
        SERIES_PENDING_STATUSES.includes(a.status) &&
        a.start.getTime() > now.getTime(),
    )
    .sort((a, b) => a.series!.index - b.series!.index);
}
