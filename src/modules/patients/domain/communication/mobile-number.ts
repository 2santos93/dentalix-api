import { toE164Digits } from '../../../../shared/phone/e164';

/** MISSING: sin móvil. INVALID: hay texto pero no es un móvil válido. */
export type MobileStatus = 'MISSING' | 'VALID' | 'INVALID';

export interface NormalizedMobile {
  status: MobileStatus;
  /** E.164 con `+` (p. ej. `+573101234567`), solo si es VALID. */
  e164: string | null;
}

/**
 * Forma del número nacional de un MÓVIL por indicativo (DX-013, hasta DX-329):
 * con el 57, 10 dígitos que empiezan por 3; con el 34, 9 que empiezan por 6 o
 * 7. Un fijo pasa el largo de E.164 pero no recibe WhatsApp. Para el resto de
 * indicativos basta el largo E.164 de `toE164Digits`.
 */
const MOBILE_BY_CALLING_CODE: ReadonlyArray<[string, RegExp]> = [
  ['57', /^3\d{9}$/],
  ['34', /^[67]\d{8}$/],
];

/**
 * Valida y normaliza el móvil del paciente (DX-128) con la regla del botón de
 * WhatsApp (`toE164Digits`, DX-005): con `+` o `00` el número ya trae su
 * indicativo; sin él se usa `defaultCallingCode`, que calcula la aplicación
 * (DX-312). Sin indicativo por defecto, un número sin `+` es INVALID.
 */
export function normalizeMobile(
  phone: string | null | undefined,
  defaultCallingCode: string | null,
): NormalizedMobile {
  if (!phone?.trim()) return { status: 'MISSING', e164: null };
  const digits = toE164Digits(phone, defaultCallingCode);
  if (!digits) return { status: 'INVALID', e164: null };
  for (const [code, mobile] of MOBILE_BY_CALLING_CODE) {
    if (digits.startsWith(code) && !mobile.test(digits.slice(code.length))) {
      return { status: 'INVALID', e164: null };
    }
  }
  return { status: 'VALID', e164: `+${digits}` };
}
