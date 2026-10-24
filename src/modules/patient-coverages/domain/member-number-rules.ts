/**
 * Nº de afiliado o póliza de una cobertura (SEC-049). Con un pagador externo
 * (EPS, prepagada, mutua o aseguradora, empresa) es obligatorio en las
 * coberturas nuevas y tiene un formato básico por tipo: sin él, cualquiera
 * creaba la cobertura con solo el pagador y se asignaba el convenio. Las
 * coberturas que ya existían sin número (migradas o anteriores) se leen igual
 * y no se tocan mientras no cambie su pagador o su número.
 *
 * Es un dato personal: ningún mensaje lo repite y la auditoría solo guarda
 * sus 4 últimos caracteres (`memberNumberLast4`).
 */
import type { PayerType } from '@prisma/client';
import { isExternalPayer } from '../../payers/domain/payer-rules';

export const MEMBER_NUMBER_REPEATED_MESSAGE =
  'El nº de afiliado no puede ser un mismo carácter repetido.';

const EPS_FORMAT_MESSAGE =
  'En una EPS, el nº de afiliado es el documento del afiliado: de 5 a 15 dígitos, sin letras.';
const POLICY_FORMAT_MESSAGE =
  'El nº de póliza o de contrato debe tener de 5 a 30 caracteres (letras, números, espacios, puntos, guiones o barras), con al menos 4 dígitos.';
const EMPLOYEE_FORMAT_MESSAGE =
  'El nº de empleado o de afiliado debe tener de 5 a 30 caracteres (letras, números, espacios, puntos, guiones o barras), con al menos un dígito.';

const REQUIRED_MESSAGES: Record<Exclude<PayerType, 'OTRO'>, string> = {
  EPS_CO:
    'En una EPS, el nº de afiliado es obligatorio: es el documento del afiliado.',
  PREPAGADA_CO:
    'En una prepagada, el nº de contrato o de afiliado es obligatorio.',
  MUTUA_ES:
    'En una mutua o aseguradora, el nº de póliza o de tarjeta es obligatorio.',
  EMPRESA:
    'En un convenio de empresa, el nº de empleado o de afiliado es obligatorio.',
};

/** Alfanumérico en los extremos; en medio, también espacio . - / */
const SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9 ./-]*[A-Za-z0-9])?$/;
const EPS_SHAPE = /^\d(?:[\d .-]*\d)?$/;

/** ¿El tipo de pagador exige nº de afiliado? Los externos; OTRO no. */
export function requiresMemberNumber(type: PayerType): boolean {
  return isExternalPayer(type);
}

export function memberNumberRequiredMessage(
  type: Exclude<PayerType, 'OTRO'>,
): string {
  return REQUIRED_MESSAGES[type];
}

/** Recorta los extremos y colapsa los espacios internos; vacío = `null`. */
export function normalizeMemberNumber(
  value: string | null | undefined,
): string | null {
  return value?.trim().replace(/\s+/g, ' ') || null;
}

const alphanumerics = (value: string): string =>
  value.replace(/[^A-Za-z0-9]/g, '');

const digitCount = (value: string): number => value.replace(/\D/g, '').length;

/**
 * Mensaje en español si el número no vale para ese tipo de pagador, o `null`.
 * Recibe el número ya normalizado. Nunca repite el valor.
 */
export function memberNumberError(
  type: PayerType,
  value: string | null,
): string | null {
  if (type === 'OTRO') return null;
  if (value === null) return memberNumberRequiredMessage(type);
  const chars = alphanumerics(value);
  if (type === 'EPS_CO') {
    const digits = digitCount(value);
    if (!EPS_SHAPE.test(value) || digits < 5 || digits > 15) {
      return EPS_FORMAT_MESSAGE;
    }
  } else {
    const minDigits = type === 'EMPRESA' ? 1 : 4;
    if (
      !SHAPE.test(value) ||
      value.length < 5 ||
      value.length > 30 ||
      digitCount(value) < minDigits
    ) {
      return type === 'EMPRESA'
        ? EMPLOYEE_FORMAT_MESSAGE
        : POLICY_FORMAT_MESSAGE;
    }
  }
  if (new Set(chars.toUpperCase()).size === 1) {
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
  return chars.length > 4 ? chars.slice(-4) : null;
}

/** ¿Cambia el número? Compara lo normalizado (otros espacios no cuentan). */
export function memberNumberChanged(
  current: string | null,
  next: string | null | undefined,
): boolean {
  return normalizeMemberNumber(current) !== normalizeMemberNumber(next);
}
