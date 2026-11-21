import { AppointmentStatus } from '@prisma/client';
import { civilDateIn, civilDayRange } from '../../../shared/time/civil-day';

/**
 * DX-265: «Ya llegué». El paciente marca su llegada desde el enlace de su cita
 * (DX-005) o con el QR de la sede (documento + fecha de nacimiento). Reglas
 * puras: la ventana de la sede, el retraso y qué le dice la página.
 */

// --- Ajustes de la sede --------------------------------------------------------

export interface CheckInSettings {
  /** «Ya llegué» en la página del enlace de la cita. */
  linkEnabled: boolean;
  /** Se puede marcar desde N minutos antes del inicio… */
  minutesBefore: number;
  /** …hasta N minutos después. */
  minutesAfter: number;
  /** Llegar más tarde que esto (minutos tras el inicio) → «Pase por recepción». */
  lateMinutes: number;
}

/** Sin fila de ajustes: enlace activo, de 30 min antes a 30 después, retraso desde 10. */
export const DEFAULT_CHECK_IN_SETTINGS: Readonly<CheckInSettings> = {
  linkEnabled: true,
  minutesBefore: 30,
  minutesAfter: 30,
  lateMinutes: 10,
};

export const CHECK_IN_MINUTES_MAX = 240;

export const CHECK_IN_SETTINGS_MESSAGES = {
  range: `Los minutos van de 0 a ${CHECK_IN_MINUTES_MAX}.`,
  locationNotFound: 'Sede no encontrada o retirada',
  qrNotFound: 'La sede no tiene un QR de llegada activo.',
} as const;

/** Error del primer campo fuera de rango, o `null`. */
export function checkInSettingsError(
  patch: Partial<CheckInSettings>,
): string | null {
  for (const key of ['minutesBefore', 'minutesAfter', 'lateMinutes'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < 0 || v > CHECK_IN_MINUTES_MAX) {
      return CHECK_IN_SETTINGS_MESSAGES.range;
    }
  }
  return null;
}

// --- Ventana -------------------------------------------------------------------

/** Estados desde los que el paciente puede marcar la llegada (los mismos que recepción). */
export const SELF_ARRIVABLE: ReadonlySet<AppointmentStatus> = new Set([
  AppointmentStatus.SCHEDULED,
  AppointmentStatus.CONFIRMED,
]);

/** Ya está en la clínica (llegó por su cuenta o lo marcó recepción). */
const ALREADY_IN: ReadonlySet<AppointmentStatus> = new Set([
  AppointmentStatus.ARRIVED,
  AppointmentStatus.IN_CHAIR,
  AppointmentStatus.READY_FOR_CHECKOUT,
]);

/**
 * - AVAILABLE: hoy, dentro de la ventana y la cita agendada o confirmada.
 * - TOO_EARLY / TOO_LATE: hoy, pero antes o después de la ventana.
 * - ARRIVED: ya consta su llegada (idempotente).
 * - UNAVAILABLE: cualquier otra cosa (otro día, cancelada, atendida, la sede
 *   no lo ofrece…). La página no explica por qué: «pase por recepción».
 */
export type ArrivalState =
  'AVAILABLE' | 'TOO_EARLY' | 'TOO_LATE' | 'ARRIVED' | 'UNAVAILABLE';

export interface ArrivalWindowInput {
  start: Date;
  status: AppointmentStatus;
  /** Zona IANA de la sede; sin ella, no se ofrece. */
  timeZone: string | null;
  settings: CheckInSettings;
  now: Date;
}

export interface ArrivalWindow {
  state: ArrivalState;
  /** Desde cuándo (y hasta cuándo) se puede marcar HOY; null si no es hoy. */
  opensAt: Date | null;
  closesAt: Date | null;
}

const MINUTE = 60_000;

/**
 * La ventana de la sede, siempre dentro del día civil de la cita en SU zona
 * (la llegada solo se marca el día de la cita, como en recepción).
 */
export function arrivalWindow(input: ArrivalWindowInput): ArrivalWindow {
  const none: ArrivalWindow = {
    state: 'UNAVAILABLE',
    opensAt: null,
    closesAt: null,
  };
  if (ALREADY_IN.has(input.status)) {
    return { state: 'ARRIVED', opensAt: null, closesAt: null };
  }
  if (!SELF_ARRIVABLE.has(input.status) || !input.timeZone) return none;
  const zone = input.timeZone;
  const day = civilDateIn(input.start, zone);
  if (civilDateIn(input.now, zone) !== day) return none;
  const range = civilDayRange(day, zone);
  const opensAt = new Date(
    Math.max(
      input.start.getTime() - input.settings.minutesBefore * MINUTE,
      range.start.getTime(),
    ),
  );
  const closesAt = new Date(
    Math.min(
      input.start.getTime() + input.settings.minutesAfter * MINUTE,
      range.end.getTime() - 1,
    ),
  );
  const t = input.now.getTime();
  const state: ArrivalState =
    t < opensAt.getTime()
      ? 'TOO_EARLY'
      : t > closesAt.getTime()
        ? 'TOO_LATE'
        : 'AVAILABLE';
  return { state, opensAt, closesAt };
}

// --- Triaje ----------------------------------------------------------------------

/**
 * Lo que recepción tiene que resolver con el paciente antes de que se siente.
 * - ANAMNESIS: sin anamnesis o caducada (regla DX-247, el día de la cita).
 * - CONSENT: sin autorización de tratamiento de datos (general o de salud) o
 *   con un consentimiento enviado para firmar a distancia sin firmar.
 * - PATIENT_DATA: falta documento, fecha de nacimiento o teléfono.
 * - LATE: llegó más tarde que el umbral de la sede.
 */
export const CHECK_IN_PENDING = [
  'ANAMNESIS',
  'CONSENT',
  'PATIENT_DATA',
  'LATE',
] as const;
export type CheckInPending = (typeof CHECK_IN_PENDING)[number];

/** Qué le dice la página: «Tome asiento» o «Pase por recepción». */
export type CheckInResult = 'TAKE_SEAT' | 'SEE_RECEPTION';

/** ¿Llegó más tarde que el umbral de la sede? */
export function isLateArrival(
  start: Date,
  arrivedAt: Date,
  lateMinutes: number,
): boolean {
  return arrivedAt.getTime() > start.getTime() + lateMinutes * MINUTE;
}

/** Los pendientes en orden canónico, sin repetir. */
export function orderPending(
  items: Iterable<CheckInPending>,
): CheckInPending[] {
  const set = new Set(items);
  return CHECK_IN_PENDING.filter((p) => set.has(p));
}

export function checkInResult(
  pending: readonly CheckInPending[],
): CheckInResult {
  return pending.length > 0 ? 'SEE_RECEPTION' : 'TAKE_SEAT';
}

// --- Mensajes de la ruta pública (español, tú como el resto del enlace) ------------

export const ARRIVAL_MESSAGES = {
  TOO_EARLY:
    'Aún es pronto para marcar tu llegada. Vuelve a intentarlo un poco antes de la hora de tu cita.',
  TOO_LATE:
    'Ya no se puede marcar la llegada desde aquí. Pasa por recepción, por favor.',
  UNAVAILABLE:
    'Esta cita no admite marcar la llegada desde aquí. Pasa por recepción, por favor.',
} as const;
