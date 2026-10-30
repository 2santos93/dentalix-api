import { callingCodeOfCountry } from '../../../shared/phone/country-calling-code';
import { toE164Digits } from '../../../shared/phone/e164';

/**
 * Número para `https://wa.me/<número>`: E.164 sin `+` ni separadores. Sin `+`
 * se usa el indicativo provisional de `countryCode` (DX-312, hasta DX-329); un
 * país sin indicativo da `null` (la web deshabilita "Abrir WhatsApp" y lo
 * explica).
 */
export function toWhatsAppNumber(
  phone: string | null,
  countryCode: string | null,
): string | null {
  return toE164Digits(phone, callingCodeOfCountry(countryCode));
}
