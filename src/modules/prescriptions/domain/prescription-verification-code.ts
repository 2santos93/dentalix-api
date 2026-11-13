import { randomInt } from 'node:crypto';

/**
 * DX-467: código corto con el que se verifica una receta impresa (y su QR,
 * hacia `/receta/<código>`). 31 símbolos sin los ambiguos al leerlo en papel o
 * dictarlo (ni 0/O ni 1/I/L): dígitos 2–9 y letras mayúsculas salvo I, L y O.
 * Debe coincidir con la función `dx_prescription_verification_code()` y el
 * CHECK `prescriptions_verification_code_check` de la migración
 * 20261216090000_dx467_prescription_verification_code.
 */
export const PRESCRIPTION_VERIFICATION_ALPHABET =
  '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** 12 símbolos de 31: ~59 bits, imposible de barrer con el límite por IP. */
export const PRESCRIPTION_VERIFICATION_CODE_LENGTH = 12;

const CODE_SHAPE = /^[2-9A-HJKMNP-Z]{12}$/;

/**
 * Un código nuevo, uniforme, con el CSPRNG del sistema (`randomInt` no tiene
 * sesgo de módulo). Nunca se deriva del id ni de nada de la receta.
 */
export function generatePrescriptionVerificationCode(
  random: (max: number) => number = (max) => randomInt(0, max),
): string {
  let code = '';
  for (let i = 0; i < PRESCRIPTION_VERIFICATION_CODE_LENGTH; i++) {
    code +=
      PRESCRIPTION_VERIFICATION_ALPHABET[
        random(PRESCRIPTION_VERIFICATION_ALPHABET.length)
      ];
  }
  return code;
}

/**
 * El código tal como llega en la URL (o tecleado): sin espacios ni guiones de
 * la agrupación impresa y en mayúsculas. `null` si no tiene la forma de un
 * código: la ruta pública responde entonces el mismo 404 que a uno que no
 * existe, sin consultar la base.
 */
export function normalizePrescriptionVerificationCode(
  raw: string,
): string | null {
  if (raw.length > 64) return null;
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return CODE_SHAPE.test(code) ? code : null;
}

/** Agrupado de 4 en 4 para leerlo en papel: `ABCD-EFGH-JKMN`. */
export function formatPrescriptionVerificationCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}
