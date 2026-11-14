import {
  phoneReadings,
  parsePhone,
  type PhoneRegion,
} from '../../../../shared/phone/phone-number';

/** Menos dígitos que esto no identifican a nadie: «Escribe el número completo». */
export const MIN_CALLER_DIGITS = 7;

/**
 * El E.164 con el que se guarda un teléfono para buscarlo (DX-224, A1): la
 * lectura de la librería con la región por defecto de la sede (nunca una regla
 * por país ni una comparación de sufijos). `null` si no vale, si es ambiguo
 * (dos lecturas válidas distintas: la búsqueda prueba las dos) o si está vacío.
 * Un fijo vale igual que un móvil: quien llama puede llamar desde cualquiera.
 */
export function storedPhoneE164(
  phone: string | null | undefined,
  region: PhoneRegion | null,
): string | null {
  return parsePhone(phone, region)?.e164 ?? null;
}

export type CallerPhoneCandidates =
  | { status: 'TOO_SHORT' }
  | { status: 'NONE' }
  | { status: 'OK'; e164s: string[] };

/** Cuántos dígitos decimales (de cualquier escritura) trae el texto. */
function digitCount(text: string): number {
  return (text.normalize('NFKC').match(/\p{Nd}/gu) ?? []).length;
}

/**
 * Los E.164 que puede ser el número que escribe recepción, en cualquier
 * formato (con espacios, puntos, guiones o paréntesis, con o sin el 0 troncal
 * ni el «+»). Con `+` manda
 * su indicativo; sin él, el de la sede activa. Una lectura ambigua da las dos
 * (se busca cualquiera). Se compara siempre el E.164 completo.
 */
export function callerPhoneCandidates(
  text: string,
  region: PhoneRegion | null,
): CallerPhoneCandidates {
  if (digitCount(text) < MIN_CALLER_DIGITS) return { status: 'TOO_SHORT' };
  const e164s = phoneReadings(text, region);
  return e164s.length ? { status: 'OK', e164s } : { status: 'NONE' };
}
