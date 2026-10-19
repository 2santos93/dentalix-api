import { AppointmentStatus, ClinicRole } from '@prisma/client';

/**
 * DX-200: flujo del paciente en la clínica. Recepción marca «Llegó», el
 * odontólogo (o la asistente) «En sillón» y «Listo para cobrar», y la salida
 * la cierra recepción con COMPLETED. Estos tres estados cuentan como «en
 * curso»: ocupan el hueco, no son una inasistencia y no reciben recordatorios.
 */
export const IN_CLINIC_STATUSES = [
  AppointmentStatus.ARRIVED,
  AppointmentStatus.IN_CHAIR,
  AppointmentStatus.READY_FOR_CHECKOUT,
] as const satisfies readonly AppointmentStatus[];

export type InClinicStatus = (typeof IN_CLINIC_STATUSES)[number];

const IN_CLINIC: ReadonlySet<AppointmentStatus> = new Set(IN_CLINIC_STATUSES);

export function isInClinic(
  status: AppointmentStatus,
): status is InClinicStatus {
  return IN_CLINIC.has(status);
}

/** Desde dónde se marca la llegada: la cita sigue por venir. */
const ARRIVABLE: ReadonlySet<AppointmentStatus> = new Set([
  AppointmentStatus.SCHEDULED,
  AppointmentStatus.CONFIRMED,
]);

/** Llegada y salida (también «Deshacer llegada»): el mostrador. */
export const FRONT_DESK_ROLES: readonly ClinicRole[] = [
  ClinicRole.RECEPTION,
  ClinicRole.ASSISTANT,
  ClinicRole.ADMIN,
];

/** En sillón y listo para cobrar: quien atiende. */
export const CHAIRSIDE_ROLES: readonly ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.ADMIN,
];

export const PATIENT_FLOW_MESSAGES = {
  arriveForbidden:
    'La llegada la marcan recepción, la asistente o la administración.',
  chairsideForbidden:
    '«En sillón» y «Listo para cobrar» los marcan el odontólogo, la asistente o la administración.',
  checkoutForbidden:
    'La salida de un paciente en la clínica la marcan recepción, la asistente o la administración.',
  notToday: 'La llegada solo se marca el día de la cita.',
  arriveFrom: 'Solo se marca la llegada de una cita agendada o confirmada.',
  seatFrom: 'Para pasarlo al sillón, el paciente tiene que haber llegado.',
  readyFrom:
    'Para dejarlo listo para cobrar, el paciente tiene que estar en el sillón.',
  notNoShow: 'El paciente llegó: no es una inasistencia.',
  cancelInTreatment:
    'El paciente ya pasó al sillón: termina la cita en vez de cancelarla.',
  backToScheduled:
    'Para volver a agendada usa «Deshacer llegada» (solo antes de pasar al sillón).',
  undoNotArrived: 'Solo se deshace la llegada de un paciente en espera.',
  moveInClinic:
    'El paciente está en la clínica: completa la cita o deshaz la llegada antes de moverla a otro día.',
  stale: 'La cita cambió mientras tanto. Recarga la agenda.',
} as const;

export type TransitionCheck =
  { ok: true } | { ok: false; kind: 'FORBIDDEN' | 'CONFLICT'; message: string };

const OK: TransitionCheck = { ok: true };

function forbidden(message: string): TransitionCheck {
  return { ok: false, kind: 'FORBIDDEN', message };
}

function conflict(message: string): TransitionCheck {
  return { ok: false, kind: 'CONFLICT', message };
}

function allowed(
  role: ClinicRole | null,
  roles: readonly ClinicRole[],
): boolean {
  return role !== null && roles.includes(role);
}

export interface TransitionInput {
  from: AppointmentStatus;
  to: AppointmentStatus;
  role: ClinicRole | null;
  /** La cita es de hoy en la zona de su sede. */
  isToday: boolean;
  /**
   * El paciente llegó en esta cita (`arrivedAt`), aunque ya haya salido del
   * flujo (completada, o cancelada tras irse sin pasar al sillón): nunca es
   * una inasistencia.
   */
  arrived?: boolean;
}

/**
 * ¿Se puede pasar la cita de `from` a `to`? Sin saltos imposibles: llegó
 * solo desde agendada/confirmada y el mismo día; sillón solo tras llegar;
 * listo solo desde el sillón. Las transiciones entre los estados de siempre
 * (agendada, confirmada, completada, cancelada, no-show) no cambian.
 * «Deshacer llegada» no pasa por aquí: tiene su propia operación.
 */
export function checkStatusTransition(input: TransitionInput): TransitionCheck {
  const { from, to, role } = input;
  if (from === to) return OK;

  switch (to) {
    case AppointmentStatus.ARRIVED:
      if (!ARRIVABLE.has(from))
        return conflict(PATIENT_FLOW_MESSAGES.arriveFrom);
      if (!allowed(role, FRONT_DESK_ROLES)) {
        return forbidden(PATIENT_FLOW_MESSAGES.arriveForbidden);
      }
      if (!input.isToday) return conflict(PATIENT_FLOW_MESSAGES.notToday);
      return OK;
    case AppointmentStatus.IN_CHAIR:
      if (from !== AppointmentStatus.ARRIVED) {
        return conflict(PATIENT_FLOW_MESSAGES.seatFrom);
      }
      return allowed(role, CHAIRSIDE_ROLES)
        ? OK
        : forbidden(PATIENT_FLOW_MESSAGES.chairsideForbidden);
    case AppointmentStatus.READY_FOR_CHECKOUT:
      if (from !== AppointmentStatus.IN_CHAIR) {
        return conflict(PATIENT_FLOW_MESSAGES.readyFrom);
      }
      return allowed(role, CHAIRSIDE_ROLES)
        ? OK
        : forbidden(PATIENT_FLOW_MESSAGES.chairsideForbidden);
  }

  // Llegó (aunque luego se completara o se cancelara): nunca un no-show.
  if (to === AppointmentStatus.NO_SHOW && input.arrived) {
    return conflict(PATIENT_FLOW_MESSAGES.notNoShow);
  }

  if (!isInClinic(from)) return OK;

  // Sale del flujo: la cita está en la clínica.
  switch (to) {
    case AppointmentStatus.COMPLETED:
      return allowed(role, FRONT_DESK_ROLES)
        ? OK
        : forbidden(PATIENT_FLOW_MESSAGES.checkoutForbidden);
    case AppointmentStatus.CANCELLED:
      // Se fue sin pasar al sillón; después ya hubo atención.
      if (from !== AppointmentStatus.ARRIVED) {
        return conflict(PATIENT_FLOW_MESSAGES.cancelInTreatment);
      }
      return allowed(role, FRONT_DESK_ROLES)
        ? OK
        : forbidden(PATIENT_FLOW_MESSAGES.checkoutForbidden);
    case AppointmentStatus.NO_SHOW:
      return conflict(PATIENT_FLOW_MESSAGES.notNoShow);
    default:
      return conflict(PATIENT_FLOW_MESSAGES.backToScheduled);
  }
}

/** La hora que se fija al ENTRAR en cada estado del flujo. */
export const FLOW_TIMESTAMP_FIELD = {
  [AppointmentStatus.ARRIVED]: 'arrivedAt',
  [AppointmentStatus.IN_CHAIR]: 'seatedAt',
  [AppointmentStatus.READY_FOR_CHECKOUT]: 'readyForCheckoutAt',
} as const satisfies Record<InClinicStatus, string>;

/** Puntualidad de la llegada: el color del chip del panel. */
export type Punctuality = 'ON_TIME' | 'LATE' | 'VERY_LATE';

/** Tolerancia del naranja: hasta 5 minutos tarde. */
export const LATE_TOLERANCE_MS = 5 * 60_000;

/** Verde si llegó a la hora o antes, naranja hasta 5 min tarde, rojo después. */
export function arrivalPunctuality(start: Date, arrivedAt: Date): Punctuality {
  const late = arrivedAt.getTime() - start.getTime();
  if (late <= 0) return 'ON_TIME';
  return late <= LATE_TOLERANCE_MS ? 'LATE' : 'VERY_LATE';
}

/** Minutos enteros desde `since` hasta `now` (0 si `now` es anterior). */
export function minutesSince(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
}
