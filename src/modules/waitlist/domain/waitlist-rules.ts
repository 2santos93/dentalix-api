/** Reglas y textos de «Pendientes por agendar» (DX-122). */

export const WAITLIST_DEFAULT_PAGE_SIZE = 20;
export const WAITLIST_MAX_PAGE_SIZE = 50;
export const WAITLIST_PREFERRED_WINDOW_MAX = 80;
export const WAITLIST_NOTE_MAX = 500;
export const WAITLIST_DISMISS_REASON_MAX = 200;
/** Duración por defecto de un alta manual sin tipo de cita. */
export const WAITLIST_DEFAULT_DURATION_MINUTES = 30;

export const WAITLIST_NOT_FOUND_MESSAGE = 'Pendiente no encontrado';
export const WAITLIST_NOT_OPEN_MESSAGE =
  'Este paciente ya no está en pendientes: alguien lo agendó o lo descartó.';

/** Texto opcional: recortado, no vacío y con tope; `null` si no vino. */
export function textError(
  value: string | undefined,
  label: string,
  max: number,
): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return `${label} no puede estar vacío`;
  if (trimmed.length > max)
    return `${label} admite como mucho ${max} caracteres`;
  return null;
}

export function dismissReasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length === 0)
    return 'Indica el motivo para descartar al paciente de pendientes';
  if (trimmed.length > WAITLIST_DISMISS_REASON_MAX) {
    return `El motivo admite como mucho ${WAITLIST_DISMISS_REASON_MAX} caracteres`;
  }
  return null;
}

/**
 * Duración (min) de la cita de origen para buscarle hueco: redondeada a 5 y
 * entre 5 y 480, como los tipos de cita. Igual que el SQL del alta automática.
 */
export function durationFromAppointment(start: Date, end: Date): number {
  const minutes = Math.round((end.getTime() - start.getTime()) / 300_000) * 5;
  return Math.min(480, Math.max(5, minutes));
}
