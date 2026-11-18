import type {
  OnlineBookingMode,
  OnlineBookingPatientKind,
} from '@prisma/client';

/**
 * DX-016: ajustes de la reserva online de la clínica. Sin fila guardada, los
 * de abajo: DESACTIVADA y en modo solicitud para todos.
 */
export interface OnlineBookingSettings {
  enabled: boolean;
  newPatientMode: OnlineBookingMode;
  existingPatientMode: OnlineBookingMode;
  minLeadMinutesNew: number;
  minLeadMinutesExisting: number;
  maxAdvanceDays: number;
  slotStepMinutes: number;
  updatedAt: Date | null;
}

export const DEFAULT_ONLINE_BOOKING_SETTINGS: OnlineBookingSettings = {
  enabled: false,
  newPatientMode: 'REQUEST',
  existingPatientMode: 'REQUEST',
  minLeadMinutesNew: 120,
  minLeadMinutesExisting: 120,
  maxAdvanceDays: 60,
  slotStepMinutes: 15,
  updatedAt: null,
};

/** Topes (los mismos CHECK de la migración 20270109090200). */
export const ONLINE_LEAD_MAX_MINUTES = 7 * 24 * 60;
export const ONLINE_ADVANCE_MAX_DAYS = 365;
export const ONLINE_STEP_MIN = 5;
export const ONLINE_STEP_MAX = 60;
export const ONLINE_DURATION_MIN = 5;
export const ONLINE_DURATION_MAX = 480;
export const ONLINE_MAX_IDS = 200;

export function modeFor(
  settings: OnlineBookingSettings,
  kind: OnlineBookingPatientKind,
): OnlineBookingMode {
  return kind === 'NEW'
    ? settings.newPatientMode
    : settings.existingPatientMode;
}

export function leadFor(
  settings: OnlineBookingSettings,
  kind: OnlineBookingPatientKind,
): number {
  return kind === 'NEW'
    ? settings.minLeadMinutesNew
    : settings.minLeadMinutesExisting;
}

/** Un tipo de cita del catálogo en la reserva online. */
export interface OnlineTypeSettings {
  appointmentTypeId: string;
  visibleOnline: boolean;
  /** `null` = la duración del tipo. */
  durationNewMinutes: number | null;
  durationExistingMinutes: number | null;
  /** Vacío = todos los profesionales que atienden en la sede. */
  providerIds: string[];
  /** Vacío = todas las sedes activas. */
  locationIds: string[];
}

/** Lo que el ADMIN ve de cada tipo del catálogo. */
export interface OnlineTypeView extends OnlineTypeSettings {
  name: string;
  color: string;
  durationMinutes: number;
  active: boolean;
}

export function durationFor(
  type: { durationMinutes: number },
  online: Pick<
    OnlineTypeSettings,
    'durationNewMinutes' | 'durationExistingMinutes'
  >,
  kind: OnlineBookingPatientKind,
): number {
  const own =
    kind === 'NEW' ? online.durationNewMinutes : online.durationExistingMinutes;
  return own ?? type.durationMinutes;
}

export const ONLINE_SETTINGS_MESSAGES = {
  lead: `La antelación mínima va de 0 a ${ONLINE_LEAD_MAX_MINUTES} minutos (7 días).`,
  advance: `La antelación máxima va de 1 a ${ONLINE_ADVANCE_MAX_DAYS} días.`,
  step: `Los huecos empiezan cada ${ONLINE_STEP_MIN}–${ONLINE_STEP_MAX} minutos, en múltiplos de 5.`,
  leadBeyondAdvance:
    'La antelación mínima no puede ser mayor que la máxima: no quedaría ningún hueco.',
  duration: `La duración va de ${ONLINE_DURATION_MIN} a ${ONLINE_DURATION_MAX} minutos, en múltiplos de 5.`,
  tooManyIds: `Elige como mucho ${ONLINE_MAX_IDS} profesionales y ${ONLINE_MAX_IDS} sedes.`,
  unknownLocation: 'Alguna sede no existe o está desactivada.',
  unknownProvider:
    'Algún profesional no es de la clínica o su rol no atiende pacientes.',
  typeNotFound: 'Tipo de cita no encontrado',
  inactiveType:
    'El tipo de cita está desactivado: actívalo en el catálogo antes de ofrecerlo online.',
} as const;

function intIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** El problema del primer valor fuera de rango, o `null`. */
export function settingsProblem(s: OnlineBookingSettings): string | null {
  if (
    !intIn(s.minLeadMinutesNew, 0, ONLINE_LEAD_MAX_MINUTES) ||
    !intIn(s.minLeadMinutesExisting, 0, ONLINE_LEAD_MAX_MINUTES)
  ) {
    return ONLINE_SETTINGS_MESSAGES.lead;
  }
  if (!intIn(s.maxAdvanceDays, 1, ONLINE_ADVANCE_MAX_DAYS)) {
    return ONLINE_SETTINGS_MESSAGES.advance;
  }
  if (
    !intIn(s.slotStepMinutes, ONLINE_STEP_MIN, ONLINE_STEP_MAX) ||
    s.slotStepMinutes % 5 !== 0
  ) {
    return ONLINE_SETTINGS_MESSAGES.step;
  }
  const advanceMinutes = s.maxAdvanceDays * 24 * 60;
  if (
    s.minLeadMinutesNew >= advanceMinutes ||
    s.minLeadMinutesExisting >= advanceMinutes
  ) {
    return ONLINE_SETTINGS_MESSAGES.leadBeyondAdvance;
  }
  return null;
}

export function durationProblem(value: number | null): string | null {
  if (value === null) return null;
  return intIn(value, ONLINE_DURATION_MIN, ONLINE_DURATION_MAX) &&
    value % 5 === 0
    ? null
    : ONLINE_SETTINGS_MESSAGES.duration;
}
