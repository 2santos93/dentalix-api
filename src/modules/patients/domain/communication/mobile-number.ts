import { toWhatsAppNumber } from '../../../appointment-confirmations/application/whatsapp-phone';

/** MISSING: sin móvil. INVALID: hay texto pero no es un móvil válido. */
export type MobileStatus = 'MISSING' | 'VALID' | 'INVALID';

export interface NormalizedMobile {
  status: MobileStatus;
  /** E.164 con `+` (p. ej. `+573101234567`), solo si es VALID. */
  e164: string | null;
}

/**
 * Forma del número nacional de un MÓVIL en los países de las sedes (DX-013):
 * en Colombia los móviles son 10 dígitos que empiezan por 3; en España, 9 que
 * empiezan por 6 o 7. Un fijo pasa el largo de E.164 pero no recibe WhatsApp.
 * Para el resto de indicativos basta el largo E.164 de `toWhatsAppNumber`.
 */
const MOBILE_BY_CALLING_CODE: ReadonlyArray<[string, RegExp]> = [
  ['57', /^3\d{9}$/],
  ['34', /^[67]\d{8}$/],
];

/**
 * Valida y normaliza el móvil del paciente (DX-128) reutilizando la regla del
 * botón de WhatsApp (`toWhatsAppNumber`, DX-005): con `+` o `00` el número ya
 * trae su indicativo; sin él se usa el de `countryCode` (el país de la sede).
 */
export function normalizeMobile(
  phone: string | null | undefined,
  countryCode: string | null,
): NormalizedMobile {
  if (!phone?.trim()) return { status: 'MISSING', e164: null };
  const digits = toWhatsAppNumber(phone, countryCode);
  if (!digits) return { status: 'INVALID', e164: null };
  for (const [code, mobile] of MOBILE_BY_CALLING_CODE) {
    if (digits.startsWith(code) && !mobile.test(digits.slice(code.length))) {
      return { status: 'INVALID', e164: null };
    }
  }
  return { status: 'VALID', e164: `+${digits}` };
}
