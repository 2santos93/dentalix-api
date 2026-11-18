import { localizedTextEntries } from '../../../shared/i18n/localized-text';
import {
  normalizePatientPlainText,
  patientPlainTextFromEntries,
  type PatientPlainTextEntry,
  type PatientPlainTextRules,
} from '../../../shared/i18n/patient-plain-text';

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

/* ───────────── DX-564: indicaciones previas a la cita ───────────── */

/** Caracteres de cada texto, tras recortar. */
export const PRE_VISIT_INSTRUCTIONS_TEXT_MAX = 600;
/** Idiomas por tipo (la lista de la clínica admite hasta 20; holgado para 10). */
export const PRE_VISIT_INSTRUCTIONS_MAX_LANGUAGES = 10;

/**
 * Bytes del mapa en JSON (UTF-8). El CHECK de la BD admite 8192 de jsonb; un
 * texto en una escritura de 3 bytes por carácter (chino, japonés…) en varios
 * idiomas podría pasarlo con cada texto bajo 600, y eso sería un 500. Con 8000
 * bytes de JSON el jsonb queda por debajo (lleva unos pocos bytes más por
 * entrada, menos que las comillas y escapes del JSON).
 */
export const PRE_VISIT_INSTRUCTIONS_TOTAL_BYTES_MAX = 8000;

export const PRE_VISIT_INSTRUCTIONS_TOO_LARGE_MESSAGE =
  'Las indicaciones son demasiado largas en conjunto: acorta alguno de los idiomas.';
export const PRE_VISIT_INSTRUCTIONS_NOT_A_LIST_MESSAGE =
  'Las indicaciones deben ir en una lista.';
export const PRE_VISIT_INSTRUCTIONS_TOO_MANY_MESSAGE = `Las indicaciones admiten como mucho ${PRE_VISIT_INSTRUCTIONS_MAX_LANGUAGES} idiomas.`;
export const PRE_VISIT_INSTRUCTIONS_LANGUAGE_NOT_OFFERED_MESSAGE =
  'Ese idioma no está entre los idiomas de los pacientes de la clínica.';
export const PRE_VISIT_INSTRUCTIONS_REPEATED_MESSAGE =
  'Ese idioma está repetido en las indicaciones.';
export const PRE_VISIT_INSTRUCTIONS_TOO_LONG_MESSAGE = `Las indicaciones no pueden tener más de ${PRE_VISIT_INSTRUCTIONS_TEXT_MAX} caracteres.`;
export const PRE_VISIT_INSTRUCTIONS_NO_LINKS_MESSAGE =
  'Las indicaciones no admiten enlaces ni HTML: escríbelas como texto.';

export type PreVisitInstructionEntry = PatientPlainTextEntry;

/**
 * Un texto tal como se guarda: saltos de línea `\n` (como mucho dos seguidos),
 * tabuladores como espacio, sin otros caracteres de control ni de formato
 * (salvo U+200D) y recortado. Los saltos se conservan: el recordatorio y la
 * página los pintan. DX-560: la regla vive en `shared/i18n/patient-plain-text`.
 */
export const normalizePreVisitInstructionText = normalizePatientPlainText;

const PRE_VISIT_INSTRUCTIONS_RULES: PatientPlainTextRules = {
  textMax: PRE_VISIT_INSTRUCTIONS_TEXT_MAX,
  maxLanguages: PRE_VISIT_INSTRUCTIONS_MAX_LANGUAGES,
  totalBytesMax: PRE_VISIT_INSTRUCTIONS_TOTAL_BYTES_MAX,
  messages: {
    tooMany: PRE_VISIT_INSTRUCTIONS_TOO_MANY_MESSAGE,
    repeated: PRE_VISIT_INSTRUCTIONS_REPEATED_MESSAGE,
    languageNotOffered: PRE_VISIT_INSTRUCTIONS_LANGUAGE_NOT_OFFERED_MESSAGE,
    tooLong: PRE_VISIT_INSTRUCTIONS_TOO_LONG_MESSAGE,
    noLinks: PRE_VISIT_INSTRUCTIONS_NO_LINKS_MESSAGE,
    tooLarge: PRE_VISIT_INSTRUCTIONS_TOO_LARGE_MESSAGE,
  },
};

/**
 * Valida la lista que llega de la API y la convierte en el mapa que se guarda
 * (`{ idioma: texto }`). La lista es el mapa entero: un idioma que no viene se
 * quita. Reglas (las de `patientPlainTextFromEntries`), en orden:
 *  - etiqueta BCP 47 válida (se canoniza: «EN» → «en»);
 *  - sin idiomas repetidos;
 *  - texto vacío tras recortar → se descarta esa entrada;
 *  - el idioma debe estar en la lista de la clínica, salvo que su texto sea
 *    exactamente el ya guardado (la web puede devolver lo que leyó aunque la
 *    clínica haya retirado ese idioma después: retirarlo no borra el texto);
 *  - hasta 600 caracteres; sin enlaces ni HTML;
 *  - el mapa entero, hasta 8000 bytes de JSON (la red del CHECK).
 */
export function preVisitInstructionsFromEntries(
  entries: readonly PreVisitInstructionEntry[],
  context: {
    patientLanguages: readonly string[];
    current: Readonly<Record<string, string>>;
  },
): { map: Record<string, string> } | { error: string } {
  return patientPlainTextFromEntries(
    entries,
    context,
    PRE_VISIT_INSTRUCTIONS_RULES,
  );
}

/**
 * Idiomas con texto (lo visible en la auditoría), en el orden de la API:
 * español primero y luego alfabético.
 */
export function preVisitInstructionLanguages(
  map: Readonly<Record<string, string>>,
): string[] {
  return localizedTextEntries(map).map((e) => e.language);
}
