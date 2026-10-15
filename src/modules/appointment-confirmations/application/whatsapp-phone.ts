/**
 * Indicativos telefónicos (ITU E.164) de los países donde opera Dentalix
 * (LATAM + España/Portugal/EE. UU./Canadá). Un país fuera de la lista no
 * rompe nada: el número solo se usa si el paciente lo guardó con `+`.
 */
const CALLING_CODES: Readonly<Record<string, string>> = {
  AR: '54',
  BO: '591',
  BR: '55',
  CA: '1',
  CL: '56',
  CO: '57',
  CR: '506',
  CU: '53',
  DO: '1',
  EC: '593',
  ES: '34',
  GT: '502',
  HN: '504',
  MX: '52',
  NI: '505',
  PA: '507',
  PE: '51',
  PR: '1',
  PT: '351',
  PY: '595',
  SV: '503',
  US: '1',
  UY: '598',
  VE: '58',
};

// E.164: como mucho 15 dígitos en total; menos de 8 no es un móvil real.
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

/**
 * Número para `https://wa.me/<número>`: E.164 sin `+` ni separadores. El
 * teléfono del paciente es texto libre, así que:
 * - con `+` (o `00`) ya trae el indicativo → solo se limpian los separadores;
 * - sin él, se antepone el indicativo de `countryCode` (quitando el 0 troncal
 *   y sin duplicarlo si ya venía escrito);
 * - si no se puede saber el país, o el resultado no es plausible → `null`
 *   (la web deshabilita "Abrir WhatsApp" y lo explica).
 */
export function toWhatsAppNumber(
  phone: string | null,
  countryCode: string | null,
): string | null {
  const trimmed = phone?.trim();
  if (!trimmed || /[a-z]/i.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');

  let e164: string;
  if (trimmed.startsWith('+')) {
    e164 = digits;
  } else if (digits.startsWith('00')) {
    e164 = digits.slice(2);
  } else {
    const code = countryCode ? CALLING_CODES[countryCode.toUpperCase()] : null;
    if (!code) return null;
    const national = digits.replace(/^0+/, '');
    // Ya trae el indicativo sin `+` (p. ej. "57 310…" para CO): no repetirlo
    // si lo que queda tras él tiene largo de número nacional.
    e164 =
      national.startsWith(code) && national.length - code.length >= MIN_DIGITS
        ? national
        : `${code}${national}`;
  }

  if (e164.length < MIN_DIGITS || e164.length > MAX_DIGITS) return null;
  return e164;
}
