import {
  getCountries,
  getCountryCallingCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
  type NumberType,
  type PhoneNumber,
} from 'libphonenumber-js/max';

/**
 * El único punto de `src/` que usa `libphonenumber-js` (DX-329, R11). Con el
 * build `max`, que es el que da `getType()` en todas las regiones. La librería
 * decide qué es válido y qué es móvil; aquí no hay ninguna regla por región
 * ni por indicativo, y un número sin `+` sin región por defecto no se lee
 * (nunca se adivina el indicativo).
 */

/** Código de región de numeración de la librería (ISO 3166-1 alfa-2, más AC y TA). */
export type PhoneRegion = string;

export type PhoneType = NonNullable<NumberType>;

export interface ParsedPhone {
  /** Con `+`. */
  e164: string;
  /** El E.164 sin `+` (lo que va en `wa.me`). */
  digits: string;
  type: PhoneType | null;
  /** Móvil, o fijo o móvil donde la numeración no los distingue. */
  mobile: boolean;
  international: string;
  ext: string | null;
}

export type PhoneReading =
  | { kind: 'VALID'; phone: ParsedPhone }
  | { kind: 'AMBIGUOUS'; readings: [string, string] }
  | { kind: 'NONE' };

// Solo una extensión al final, con su número (pre-flight m2).
const EXTENSION = /\s*(?:ext\.?|extensi[oó]n|x|#)\s*\d{1,6}$/iu;
/**
 * Ningún teléfono con su extensión es más largo. Se corta antes de cualquier
 * patrón: `EXTENSION` es cuadrático en una racha larga de espacios.
 */
const MAX_LENGTH = 64;
/** Fuera de la extensión, cualquier letra de cualquier escritura, o un `#`. */
const NOT_A_PHONE = /[\p{L}#]/u;
const DECIMAL_DIGIT = /\p{Nd}/gu;

/**
 * El valor de un dígito decimal de cualquier escritura. Unicode los da en
 * series contiguas de diez, del 0 al 9: el valor es la distancia al principio
 * de su racha, módulo 10.
 */
function digitValue(digit: string): string {
  const code = digit.codePointAt(0) ?? 0;
  let start = code;
  while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
  return String((code - start) % 10);
}

/**
 * NFKC (dígitos y `+` de ancho completo) y cada dígito decimal en ASCII, para
 * que las dos lecturas vean los mismos dígitos que la librería (C1).
 */
const asciiDigits = (text: string): string =>
  text.normalize('NFKC').replace(DECIMAL_DIGIT, digitValue).trim();

/**
 * El número sin la extensión del final (`ext. 3`, `x3`, `extensión 3`,
 * `#3`; pre-flight m2) y la extensión tal cual se escribió, o `''`. El texto
 * llega ya recortado y sin rachas largas de espacios (`EXTENSION` es
 * cuadrático en ellas).
 */
export function splitExtension(text: string): { body: string; ext: string } {
  const ext = EXTENSION.exec(text)?.[0] ?? '';
  return { body: text.slice(0, text.length - ext.length), ext };
}

export function phoneRegions(): readonly PhoneRegion[] {
  return getCountries();
}

export function isPhoneRegion(code: string): boolean {
  return isSupportedCountry(code);
}

/** La región, recortada y en mayúsculas, o `null` si la librería no la admite. */
export function phoneRegionOrNull(
  stored: string | null | undefined,
): PhoneRegion | null {
  const code = stored?.trim().toUpperCase();
  return code && isSupportedCountry(code) ? code : null;
}

/**
 * Región que se propone al crear una sede: la misma que su país si la
 * librería la admite (identidad, sin tablas ni comparaciones; pre-flight m15).
 */
export function suggestedPhoneRegion(
  country: string | null | undefined,
): PhoneRegion | null {
  return phoneRegionOrNull(country);
}

export type { CountryCode };

/**
 * Indicativo de una región que la librería admite, ya normalizada (la de
 * `phoneRegionOrNull`). Con cualquier otra, lanza: es un error de programa.
 */
export function callingCodeOf(region: CountryCode): string {
  return getCountryCallingCode(region);
}

function valid(text: string, region?: CountryCode): PhoneNumber | undefined {
  const parsed = parsePhoneNumberFromString(
    text,
    region ? { defaultCountry: region } : undefined,
  );
  return parsed?.isValid() ? parsed : undefined;
}

/**
 * Dos lecturas de los mismos dígitos: si las dos valen y dan números
 * distintos, es ambiguo y no se elige ninguna (pre-flight C1). Si no, la que
 * valga.
 */
function oneOf(
  asPlus: PhoneNumber | undefined,
  withRegion: PhoneNumber | undefined,
): PhoneNumber | PhoneReading | undefined {
  if (asPlus && withRegion && asPlus.number !== withRegion.number) {
    return { kind: 'AMBIGUOUS', readings: [asPlus.number, withRegion.number] };
  }
  return asPlus ?? withRegion;
}

/**
 * Interpreta un teléfono escrito a mano (R4-R5). Antes de nada, un texto de
 * más de `MAX_LENGTH` no vale y los dígitos de cualquier escritura pasan a
 * ASCII. Después:
 * - con `+`, el número trae su indicativo y la región no cuenta;
 * - con `00`, se lee como `+` y también con la región (que conoce su prefijo
 *   internacional);
 * - sin ninguno de los dos, con la región; y si los dígitos empiezan por su
 *   indicativo, también como `+`. Sin región, `NONE`.
 */
export function readPhone(
  text: string | null | undefined,
  defaultRegion: PhoneRegion | null,
): PhoneReading {
  const raw = text?.trim();
  if (!raw || raw.length > MAX_LENGTH) return { kind: 'NONE' };
  const trimmed = asciiDigits(raw);
  if (!trimmed || trimmed.length > MAX_LENGTH) return { kind: 'NONE' };
  const { body, ext } = splitExtension(trimmed);
  if (NOT_A_PHONE.test(body)) return { kind: 'NONE' };
  const region = phoneRegionOrNull(defaultRegion) as CountryCode | null;
  const digits = body.replace(/\D/g, '');

  let found: PhoneNumber | PhoneReading | undefined;
  if (body.startsWith('+')) {
    found = valid(trimmed);
  } else if (digits.startsWith('00')) {
    found = oneOf(
      valid(`+${digits.slice(2)}${ext}`),
      region ? valid(trimmed, region) : undefined,
    );
  } else {
    if (!region) return { kind: 'NONE' };
    const national = valid(trimmed, region);
    const asPlus = digits.startsWith(callingCodeOf(region))
      ? valid(`+${digits}${ext}`)
      : undefined;
    found = national ? oneOf(asPlus, national) : undefined;
  }

  if (!found) return { kind: 'NONE' };
  if ('kind' in found) return found;
  const type = found.getType() ?? null;
  return {
    kind: 'VALID',
    phone: {
      e164: found.number,
      digits: found.number.slice(1),
      type,
      mobile: type === 'MOBILE' || type === 'FIXED_LINE_OR_MOBILE',
      international: found.formatInternational(),
      ext: found.ext ?? null,
    },
  };
}

/** El teléfono si su lectura es `VALID`; si es ambigua o no vale, `null`. */
export function parsePhone(
  text: string | null | undefined,
  defaultRegion: PhoneRegion | null,
): ParsedPhone | null {
  const reading = readPhone(text, defaultRegion);
  return reading.kind === 'VALID' ? reading.phone : null;
}

/**
 * El formato internacional de la librería, con su extensión, para mostrar un
 * teléfono guardado (DX-387). `null` si la lectura es ambigua o no vale: quien
 * lo muestra cae al texto guardado tal cual.
 */
export function phoneInternational(
  text: string | null | undefined,
  defaultRegion: PhoneRegion | null,
): string | null {
  return parsePhone(text, defaultRegion)?.international ?? null;
}

/**
 * Los E.164 posibles del texto: uno si es válido, los dos si es ambiguo y
 * ninguno si no vale. Solo para la baja por mensaje (R8).
 */
export function phoneReadings(
  text: string | null | undefined,
  defaultRegion: PhoneRegion | null,
): string[] {
  const reading = readPhone(text, defaultRegion);
  if (reading.kind === 'VALID') return [reading.phone.e164];
  if (reading.kind === 'AMBIGUOUS') return [...reading.readings];
  return [];
}

/** Dígitos para `wa.me` de un número válido de cualquier tipo, o `null` (R7). */
export function whatsAppDigits(
  text: string | null | undefined,
  defaultRegion: PhoneRegion | null,
): string | null {
  return parsePhone(text, defaultRegion)?.digits ?? null;
}
