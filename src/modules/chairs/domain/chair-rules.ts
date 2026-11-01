import type { Chair } from './entities/chair.entity';

/**
 * Reglas de un sillón (DX-211). Puras: las comparten los casos de uso (400 /
 * 404 / 409 en español) y los tests; la migración repite las del nombre y el
 * orden como CHECK, que es la red si algo se saltara la API.
 */

export const CHAIR_NAME_MAX = 40;
export const CHAIR_SORT_ORDER_MAX = 999;
/** Columnas de la vista «Sillones» como mucho (como los profesionales, DX-121). */
export const MAX_CHAIR_COLUMNS = 12;

export const CHAIR_NOT_FOUND_MESSAGE = 'Sillón no encontrado';
export const DUPLICATE_CHAIR_NAME_MESSAGE =
  'Ya existe un sillón con ese nombre en esta sede.';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/;

export function normalizeChairName(name: string): string {
  return name.trim();
}

export function chairNameError(name: string): string | null {
  const trimmed = normalizeChairName(name);
  if (trimmed === '') return 'El nombre del sillón no puede estar vacío';
  if (trimmed.length > CHAIR_NAME_MAX) {
    return `El nombre del sillón no puede tener más de ${CHAIR_NAME_MAX} caracteres`;
  }
  if (CONTROL.test(trimmed)) {
    return 'El nombre del sillón no puede tener saltos de línea ni tabuladores';
  }
  return null;
}

/**
 * «Sillón 1» y «sillón 1» son el mismo sillón para quien agenda: el caso de
 * uso responde 409 antes de llegar al único de la BD (que es exacto).
 */
export function sameChairName(a: string, b: string): boolean {
  return (
    normalizeChairName(a).toLocaleLowerCase('es') ===
    normalizeChairName(b).toLocaleLowerCase('es')
  );
}

export function chairSortOrderError(sortOrder: number): string | null {
  return Number.isInteger(sortOrder) &&
    sortOrder >= 0 &&
    sortOrder <= CHAIR_SORT_ORDER_MAX
    ? null
    : `El orden del sillón debe ser un número entero entre 0 y ${CHAIR_SORT_ORDER_MAX}`;
}

export interface ChairAssignmentProblem {
  status: 400 | 404;
  message: string;
}

/**
 * ¿Puede la cita de la sede `locationId` llevar este sillón? `null` = sí.
 * - `chair` null: no existe o es de otra clínica (la RLS lo oculta): 404;
 * - de otra sede: 400 (la FK compuesta también lo impide);
 * - desactivado: 400 al ASIGNARLO (cita nueva, cambio de sillón o
 *   reagendado); `requireActive: false` cuando la cita ya lo tenía y solo
 *   cambia otra cosa.
 */
export function chairAssignmentProblem(
  chair: Chair | null,
  opts: { locationId: string; requireActive: boolean },
): ChairAssignmentProblem | null {
  if (!chair) return { status: 404, message: CHAIR_NOT_FOUND_MESSAGE };
  if (chair.locationId !== opts.locationId) {
    return {
      status: 400,
      message: `El sillón «${chair.name}» es de otra sede: elige un sillón de la sede de la cita`,
    };
  }
  if (opts.requireActive && !chair.active) {
    return {
      status: 400,
      message: `El sillón «${chair.name}» está desactivado: elige otro sillón`,
    };
  }
  return null;
}

/**
 * Profesional de una cita con sillón: el elegido manda; sin él, el
 * profesional por defecto del sillón; sin ninguno, `null` (el caso de uso
 * responde 400). Nunca sobrescribe un profesional ya elegido.
 */
export function resolveAppointmentProviderId(
  explicit: string | undefined,
  chair: Pick<Chair, 'defaultProviderId'> | null,
): string | null {
  return explicit ?? chair?.defaultProviderId ?? null;
}

/**
 * 409 de un choque por sillón: el nombre y las horas (ya formateadas en la
 * zona y el formato de la sede) de la cita que ya lo ocupa. Sin esa cita (la
 * BD resolvió una carrera y ya no se encuentra) o sin formato de la sede, sin
 * horas.
 */
export function chairOverlapMessage(
  chairName: string,
  occupied: { from: string; to: string } | null,
): string {
  if (!occupied) {
    return `El sillón «${chairName}» ya está ocupado en ese horario`;
  }
  return `El sillón «${chairName}» ya está ocupado de ${occupied.from} a ${occupied.to}`;
}
