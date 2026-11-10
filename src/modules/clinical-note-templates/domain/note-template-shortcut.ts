/**
 * Atajo de una plantilla de evolución (DX-455): se escribe en la nota
 * («#resina») para insertar la plantilla. Reglas puras: las comparten el caso
 * de uso, los repositorios y los tests.
 *
 * - Formato: «#» y de 2 a 30 letras (de cualquier alfabeto, con tildes),
 *   dígitos, «-» o «_», sin espacios.
 * - Se guarda tal cual se escribió (recortado y en Unicode NFC) y se compara
 *   sin distinguir mayúsculas: #Resina y #resina son el mismo atajo.
 * - En una clínica, ningún atajo puede empezar por otro (#re choca con
 *   #resina): al escribir «#re» no se sabría si ya es el atajo o el comienzo
 *   del otro. Las plantillas desactivadas conservan el suyo.
 */

export const NOTE_SHORTCUT_MIN = 2;
export const NOTE_SHORTCUT_MAX = 30;

/** Para class-validator y la documentación de Swagger. */
export const NOTE_SHORTCUT_PATTERN = new RegExp(
  `^#[\\p{L}\\p{M}\\p{N}_-]{${NOTE_SHORTCUT_MIN},${NOTE_SHORTCUT_MAX}}$`,
  'u',
);

export const NOTE_SHORTCUT_FORMAT_MESSAGE = `El atajo empieza por # y lleva de ${NOTE_SHORTCUT_MIN} a ${NOTE_SHORTCUT_MAX} letras, números, guiones o guiones bajos, sin espacios (p. ej. #resina).`;

/** Recorta y lleva a NFC (una «é» compuesta o descompuesta es la misma). */
export function normalizeShortcut(raw: string): string {
  return raw.trim().normalize('NFC');
}

/** null si el atajo (ya normalizado) es válido; si no, el mensaje en español. */
export function shortcutFormatError(shortcut: string): string | null {
  return NOTE_SHORTCUT_PATTERN.test(shortcut)
    ? null
    : NOTE_SHORTCUT_FORMAT_MESSAGE;
}

/** Clave de comparación: sin distinguir mayúsculas. */
export function shortcutKey(shortcut: string): string {
  return shortcut.normalize('NFC').toLowerCase();
}

/** Otra plantilla de la clínica con atajo. */
export interface ShortcutHolder {
  id: string;
  name: string;
  shortcut: string;
}

export type ShortcutConflict =
  | { kind: 'DUPLICATE'; holder: ShortcutHolder }
  | { kind: 'PREFIX'; holder: ShortcutHolder };

/**
 * El primer choque de `candidate` con los atajos de las demás plantillas de la
 * clínica (`holders` no incluye la que se edita), o null. Un duplicado exacto
 * gana a un choque de prefijo.
 */
export function findShortcutConflict(
  candidate: string,
  holders: readonly ShortcutHolder[],
): ShortcutConflict | null {
  const key = shortcutKey(candidate);
  const duplicate = holders.find((h) => shortcutKey(h.shortcut) === key);
  if (duplicate) return { kind: 'DUPLICATE', holder: duplicate };
  const prefix = holders.find((h) => {
    const other = shortcutKey(h.shortcut);
    return other.startsWith(key) || key.startsWith(other);
  });
  return prefix ? { kind: 'PREFIX', holder: prefix } : null;
}

/** Mensaje del 409 de un choque. */
export function shortcutConflictMessage(
  candidate: string,
  conflict: ShortcutConflict,
): string {
  return conflict.kind === 'DUPLICATE'
    ? `El atajo ${candidate} ya lo usa la plantilla «${conflict.holder.name}».`
    : `El atajo ${candidate} choca con ${conflict.holder.shortcut}: uno no puede empezar por el otro.`;
}

/** Mensaje del 409 cuando solo el índice único detectó el duplicado. */
export function duplicateShortcutMessage(candidate: string): string {
  return `El atajo ${candidate} ya lo usa otra plantilla de esta clínica.`;
}
