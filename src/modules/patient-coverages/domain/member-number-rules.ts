/**
 * Nº de afiliado o póliza de una cobertura (SEC-049). Con un pagador externo
 * es obligatorio en las coberturas nuevas: sin él, cualquiera creaba la
 * cobertura con solo el pagador y se asignaba el convenio. La regla de formato
 * es UNA y la misma para todo pagador externo, sin supuestos de país ni de
 * tipo de pagador (DX-311): tras normalizar, de 4 a 40 caracteres (letras,
 * dígitos, espacio, `-`, `.` o `/`), con al menos un dígito y que no sea un
 * mismo carácter repetido. Las coberturas que ya existían sin número
 * (migradas o anteriores) se leen igual y no se tocan mientras no cambie su
 * pagador o su número.
 *
 * Es un dato personal: ningún mensaje lo repite y la auditoría solo guarda
 * sus 4 últimos caracteres (`memberNumberLast4`).
 */
import type { PayerType } from '@prisma/client';
import { isExternalPayer } from '../../payers/domain/payer-rules';

export const MEMBER_NUMBER_MIN = 4;
export const MEMBER_NUMBER_RULE_MAX = 40;

export const MEMBER_NUMBER_REQUIRED_MESSAGE =
  'El nº de afiliado o póliza es obligatorio con un pagador externo.';
export const MEMBER_NUMBER_FORMAT_MESSAGE = `El nº de afiliado o póliza debe tener entre ${MEMBER_NUMBER_MIN} y ${MEMBER_NUMBER_RULE_MAX} caracteres: letras, números, espacios, guiones, puntos o barras.`;
export const MEMBER_NUMBER_DIGIT_MESSAGE =
  'El nº de afiliado o póliza debe tener al menos un número.';
export const MEMBER_NUMBER_REPEATED_MESSAGE =
  'El nº de afiliado o póliza no puede ser un mismo carácter repetido.';

/** Letras de cualquier alfabeto, dígitos 0-9, espacio y `- . /`. */
const ALLOWED = /^[\p{L}0-9 ./-]+$/u;
const NOT_ALPHANUMERIC = /[^\p{L}0-9]/gu;

/** ¿El tipo de pagador exige nº de afiliado? Los externos; OTRO no. */
export function requiresMemberNumber(type: PayerType): boolean {
  return isExternalPayer(type);
}

/** Recorta los extremos y colapsa los espacios internos; vacío = `null`. */
export function normalizeMemberNumber(
  value: string | null | undefined,
): string | null {
  return value?.trim().replace(/\s+/g, ' ') || null;
}

const alphanumerics = (value: string): string[] => [
  ...value.replace(NOT_ALPHANUMERIC, ''),
];

/**
 * Mensaje en español si el número no vale, o `null`. Recibe el número ya
 * normalizado. Nunca repite el valor.
 */
export function memberNumberError(
  type: PayerType,
  value: string | null,
): string | null {
  if (!requiresMemberNumber(type)) return null;
  if (value === null) return MEMBER_NUMBER_REQUIRED_MESSAGE;
  const length = [...value].length;
  if (
    length < MEMBER_NUMBER_MIN ||
    length > MEMBER_NUMBER_RULE_MAX ||
    !ALLOWED.test(value)
  ) {
    return MEMBER_NUMBER_FORMAT_MESSAGE;
  }
  if (!/[0-9]/.test(value)) return MEMBER_NUMBER_DIGIT_MESSAGE;
  if (new Set(alphanumerics(value.toUpperCase())).size === 1) {
    return MEMBER_NUMBER_REPEATED_MESSAGE;
  }
  return null;
}

/**
 * Los 4 últimos caracteres alfanuméricos, lo único que va a la auditoría. Un
 * número de 4 o menos no deja nada: los 4 últimos serían el número entero.
 */
export function memberNumberLast4(value: string | null): string | null {
  if (value === null) return null;
  const chars = alphanumerics(value);
  return chars.length > 4 ? chars.slice(-4).join('') : null;
}

/** ¿Cambia el número? Compara lo normalizado (otros espacios no cuentan). */
export function memberNumberChanged(
  current: string | null,
  next: string | null | undefined,
): boolean {
  return normalizeMemberNumber(current) !== normalizeMemberNumber(next);
}
