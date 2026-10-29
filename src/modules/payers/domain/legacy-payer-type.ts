/**
 * Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326.
 *
 * Única definición en la API de la correspondencia entre los códigos
 * guardados antes de DX-326 y los tipos genéricos. Los repositorios importan
 * estas funciones; nadie más nombra los códigos antiguos.
 */
import type { PayerType as StoredPayerType } from '@prisma/client';
import { PAYER_TYPES, isPayerType, type PayerType } from './payer-type';

export type LegacyStoredPayerType =
  'MUTUA_ES' | 'PREPAGADA_CO' | 'EPS_CO' | 'EMPRESA' | 'OTRO';

/** Tabla de R3: código antiguo → tipo genérico. Biyectiva. */
export const LEGACY_PAYER_TYPES: Readonly<
  Record<LegacyStoredPayerType, PayerType>
> = {
  MUTUA_ES: 'INSURER',
  PREPAGADA_CO: 'PREPAID_PLAN',
  EPS_CO: 'PUBLIC_SYSTEM',
  EMPRESA: 'EMPLOYER',
  OTRO: 'OTHER',
};

/** La tabla invertida: tipo genérico → código antiguo. */
const STORED_BY_TYPE = Object.fromEntries(
  Object.entries(LEGACY_PAYER_TYPES).map(([code, type]) => [type, code]),
) as Readonly<Record<PayerType, LegacyStoredPayerType>>;

/** Código guardado (antiguo o genérico) → tipo genérico; null si no se reconoce. */
export function payerTypeFromCode(code: string): PayerType | null {
  if (Object.hasOwn(LEGACY_PAYER_TYPES, code)) {
    return LEGACY_PAYER_TYPES[code as LegacyStoredPayerType];
  }
  return isPayerType(code) ? code : null;
}

/** Lo que usan los repositorios al leer: lanza con un código desconocido (R4). */
export function payerTypeFromStored(stored: StoredPayerType): PayerType {
  const type = payerTypeFromCode(stored);
  if (type === null) {
    throw new Error(`Código de tipo de pagador desconocido: ${String(stored)}`);
  }
  return type;
}

/** Fase 1 (R5): tipo genérico → código antiguo que se guarda. La fase 2 lo hace identidad. */
export function storedPayerType(type: PayerType): LegacyStoredPayerType {
  if (!PAYER_TYPES.includes(type)) {
    throw new Error(`Tipo de pagador desconocido: ${String(type)}`);
  }
  return STORED_BY_TYPE[type];
}

/** R9: un código antiguo en la entrada → su genérico; cualquier otro valor, sin tocar. */
export function legacyPayerTypeAlias(value: unknown): unknown {
  return typeof value === 'string' && Object.hasOwn(LEGACY_PAYER_TYPES, value)
    ? LEGACY_PAYER_TYPES[value as LegacyStoredPayerType]
    : value;
}
