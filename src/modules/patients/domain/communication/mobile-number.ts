import {
  readPhone,
  type PhoneRegion,
} from '../../../../shared/phone/phone-number';

/** MISSING: sin móvil. INVALID: hay texto pero no es un móvil válido. */
export type MobileStatus = 'MISSING' | 'VALID' | 'INVALID';

export interface NormalizedMobile {
  status: MobileStatus;
  /** E.164 con `+` (p. ej. `+573101234567`), solo si es VALID. */
  e164: string | null;
  /**
   * Los dígitos se leen como dos números válidos distintos (DX-329, C1): no
   * se elige ninguno y hay que escribirlo con `+`.
   */
  ambiguous: boolean;
}

/**
 * Valida y normaliza el móvil del paciente (DX-128, DX-329 R6). La librería
 * lee el número con la región por defecto de la sede (`readPhone`) y dice si
 * es válido y si es móvil: con `+` el número trae su indicativo; sin él, se
 * usa la región. Sin región, un número sin `+` es INVALID. Una lectura
 * ambigua nunca es VALID.
 */
export function normalizeMobile(
  phone: string | null | undefined,
  defaultRegion: PhoneRegion | null,
): NormalizedMobile {
  if (!phone?.trim())
    return { status: 'MISSING', e164: null, ambiguous: false };
  const reading = readPhone(phone, defaultRegion);
  if (reading.kind === 'VALID' && reading.phone.mobile) {
    return { status: 'VALID', e164: reading.phone.e164, ambiguous: false };
  }
  return {
    status: 'INVALID',
    e164: null,
    ambiguous: reading.kind === 'AMBIGUOUS',
  };
}
