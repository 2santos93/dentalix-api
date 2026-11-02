import { randomBytes } from 'node:crypto';
import { encodeBase32 } from './totp';

/**
 * DX-021: códigos de recuperación de la verificación en dos pasos. Cada uno
 * lleva 80 bits de azar (≥ 64 que pide la tarea) en base32 (RFC 4648, sin
 * ambigüedad 0/O ni 1/I porque el alfabeto no tiene 0, 1, 8 ni 9) y se
 * muestra en cuatro grupos: `ABCD-EFGH-IJKL-MNOP`.
 */
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 10;
const GROUP = 4;

export function generateRecoveryCode(): string {
  const raw = encodeBase32(randomBytes(RECOVERY_CODE_BYTES));
  return raw.match(new RegExp(`.{1,${GROUP}}`, 'g'))!.join('-');
}

export function generateRecoveryCodes(
  count: number = RECOVERY_CODE_COUNT,
): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateRecoveryCode());
  return [...codes];
}

/**
 * Forma canónica de lo que teclea la persona (minúsculas, espacios, guiones
 * de más) para hashearla: 16 caracteres base32 en mayúsculas, o `null`.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const clean = input.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z2-7]{16}$/.test(clean) ? clean : null;
}
