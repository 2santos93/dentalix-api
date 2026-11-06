import { randomInt } from 'node:crypto';

/**
 * DX-467: código de verificación de la receta, el que un tercero (la
 * farmacia) teclea o escanea para comprobarla en la página pública
 * `/receta/<código>` del host de la clínica.
 *
 * - 31 símbolos sin los ambiguos al leerlos o teclearlos (0/O, 1/I/L): dígitos
 *   2–9 y mayúsculas salvo I, L y O.
 * - 12 símbolos: 31^12 ≈ 7,9·10^17 (≈ 59 bits). Adivinar uno es inviable con
 *   la ruta pública limitada por IP, y la colisión dentro de una clínica es
 *   despreciable (el índice único la impide igualmente).
 * - CSPRNG: `crypto.randomInt`, que es uniforme (muestreo con rechazo), así
 *   que todos los símbolos salen con la misma probabilidad.
 *
 * El código NO entra en el hash de la receta: identifica el documento, no es
 * parte de lo prescrito. Es inmutable igualmente (el trigger
 * `prescriptions_immutable` compara la fila entera).
 */
export const PRESCRIPTION_VERIFICATION_ALPHABET =
  '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const PRESCRIPTION_VERIFICATION_CODE_LENGTH = 12;
/** Ruta de la página pública de la web. */
export const PRESCRIPTION_VERIFICATION_PATH = '/receta';

const CODE = new RegExp(
  `^[${PRESCRIPTION_VERIFICATION_ALPHABET}]{${PRESCRIPTION_VERIFICATION_CODE_LENGTH}}$`,
);
/** Lo que se acepta teclear como mucho: el código agrupado con holgura. */
const MAX_INPUT_LENGTH = 32;
const GROUP = 4;

/** Un índice uniforme en `[0, max)`. */
export type RandomIndex = (max: number) => number;

export function generatePrescriptionVerificationCode(
  random: RandomIndex = randomInt,
): string {
  const size = PRESCRIPTION_VERIFICATION_ALPHABET.length;
  let code = '';
  for (let i = 0; i < PRESCRIPTION_VERIFICATION_CODE_LENGTH; i += 1) {
    const index = random(size);
    if (!Number.isInteger(index) || index < 0 || index >= size) {
      throw new Error('Índice aleatorio fuera del alfabeto del código');
    }
    code += PRESCRIPTION_VERIFICATION_ALPHABET[index];
  }
  return code;
}

/** El código tal como se guarda: 12 símbolos del alfabeto, en mayúsculas. */
export function isPrescriptionVerificationCode(value: string): boolean {
  return CODE.test(value);
}

/**
 * Lo que llega por la URL o se teclea, en la forma guardada: sin espacios ni
 * guiones y en mayúsculas. `null` si no puede ser un código (no se consulta
 * nada con él).
 */
export function normalizePrescriptionVerificationCode(
  raw: string,
): string | null {
  if (raw.length > MAX_INPUT_LENGTH) return null;
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return isPrescriptionVerificationCode(code) ? code : null;
}

/** Para leerlo en la receta impresa: `K7M2-P9QR-T4XW`. */
export function formatPrescriptionVerificationCode(code: string): string {
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += GROUP) {
    groups.push(code.slice(i, i + GROUP));
  }
  return groups.join('-');
}

/** `base` = `<protocolo>://<host de la clínica>` (TenantLinkBaseService). */
export function prescriptionVerificationUrl(
  base: string,
  code: string,
): string {
  return `${base}${PRESCRIPTION_VERIFICATION_PATH}/${code}`;
}

/**
 * Iniciales del paciente para la página pública: una por palabra que empieza
 * por mayúscula (así «de», «los» no cuentan), con punto. Si el nombre está
 * escrito todo en minúsculas, una por palabra. Nunca el nombre en sí.
 */
export function patientInitials(name: string): string {
  const words = name.split(/[\s-]+/).filter((w) => /^\p{L}/u.test(w));
  const capitalized = words.filter((w) => /^\p{Lu}/u.test(w));
  const chosen = capitalized.length > 0 ? capitalized : words;
  return chosen.map((w) => `${w[0].toLocaleUpperCase('es')}.`).join(' ');
}

/** Lo que la página pública dice de una receta encontrada. */
export type PublicVerificationState = 'VALID' | 'VOIDED' | 'UNVERIFIABLE';

const AUDIT_REASONS = {
  VALID: 'PRESCRIPTION_VERIFIED',
  VOIDED: 'PRESCRIPTION_VERIFIED_VOIDED',
  // El hash guardado no casa con el recalculado: la receta pudo alterarse.
  UNVERIFIABLE: 'PRESCRIPTION_INTEGRITY_MISMATCH',
} as const satisfies Record<PublicVerificationState, string>;

export type PublicVerificationAuditReason =
  (typeof AUDIT_REASONS)[PublicVerificationState];

/**
 * Motivo del evento de auditoría (VIEW de PRESCRIPTION, origen PUBLIC_LINK,
 * sin actor) de cada verificación; el CHECK `audit_events_actor_check` solo
 * admite estos tres.
 */
export function publicVerificationAuditReason(
  state: PublicVerificationState,
): PublicVerificationAuditReason {
  return AUDIT_REASONS[state];
}
