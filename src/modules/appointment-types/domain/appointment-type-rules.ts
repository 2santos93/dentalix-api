/**
 * Reglas de un tipo de cita (DX-121). Puras: las comparten el caso de uso (400
 * en español) y los tests; la migración repite cada una como CHECK, que es la
 * red si algo se saltara la API.
 */

/** Solo `#RRGGBB`: el color se pinta en la agenda y nunca puede ser CSS libre. */
export const APPOINTMENT_TYPE_COLOR = /^#[0-9A-Fa-f]{6}$/;

export const APPOINTMENT_TYPE_NAME_MAX = 60;
export const APPOINTMENT_TYPE_MIN_MINUTES = 5;
export const APPOINTMENT_TYPE_MAX_MINUTES = 480;
export const APPOINTMENT_TYPE_STEP_MINUTES = 5;

export function appointmentTypeColorError(color: string): string | null {
  return APPOINTMENT_TYPE_COLOR.test(color)
    ? null
    : 'El color debe tener el formato #RRGGBB (por ejemplo, #7C3AED)';
}

/** Mayúsculas: dos tipos con «#7c3aed» y «#7C3AED» son el mismo color. */
export function normalizeAppointmentTypeColor(color: string): string {
  return color.toUpperCase();
}

export function appointmentTypeDurationError(minutes: number): string | null {
  const valid =
    Number.isInteger(minutes) &&
    minutes >= APPOINTMENT_TYPE_MIN_MINUTES &&
    minutes <= APPOINTMENT_TYPE_MAX_MINUTES &&
    minutes % APPOINTMENT_TYPE_STEP_MINUTES === 0;
  return valid
    ? null
    : `La duración debe ser un múltiplo de 5 entre ${APPOINTMENT_TYPE_MIN_MINUTES} y ${APPOINTMENT_TYPE_MAX_MINUTES} minutos`;
}

export function appointmentTypeNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'El nombre no puede estar vacío';
  if (trimmed.length > APPOINTMENT_TYPE_NAME_MAX) {
    return `El nombre no puede tener más de ${APPOINTMENT_TYPE_NAME_MAX} caracteres`;
  }
  return null;
}

/** Fin de una cita que empieza en `start` y dura `minutes`. */
export function endFromDuration(start: Date, minutes: number): Date {
  return new Date(start.getTime() + minutes * 60_000);
}
