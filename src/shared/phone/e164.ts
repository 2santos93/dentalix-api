// E.164: como mucho 15 dígitos en total; menos de 8 no es un móvil real.
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

/**
 * E.164 sin `+` ni separadores (lo que va en `https://wa.me/<número>`). El
 * teléfono del paciente es texto libre, así que:
 * - con `+` (o `00`) ya trae el indicativo → solo se limpian los separadores;
 * - sin él, se antepone `defaultCallingCode` (quitando el 0 troncal y sin
 *   duplicarlo si ya venía escrito);
 * - sin indicativo por defecto, o si el resultado no es plausible → `null`
 *   (nunca se adivina el indicativo ni se toca el 0 inicial).
 */
export function toE164Digits(
  phone: string | null,
  defaultCallingCode: string | null,
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
    const code = defaultCallingCode;
    if (!code) return null;
    const national = digits.replace(/^0+/, '');
    // Un número que ya empieza por el indicativo no lo repite, si lo que
    // queda tras él tiene largo de número nacional.
    e164 =
      national.startsWith(code) && national.length - code.length >= MIN_DIGITS
        ? national
        : `${code}${national}`;
  }

  if (e164.length < MIN_DIGITS || e164.length > MAX_DIGITS) return null;
  return e164;
}
