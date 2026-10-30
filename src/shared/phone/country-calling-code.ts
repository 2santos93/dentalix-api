/**
 * Excepción G5.3 (DX-334): indicativo por país, provisional hasta DX-329.
 * Un país fuera de la lista no tiene indicativo por defecto: el número se
 * escribe con +.
 *
 * Es la tabla anterior de `toWhatsAppNumber`, movida sin cambiar ningún valor
 * (DX-312). No se amplía: la regla de `toE164Digits` quita siempre el 0
 * inicial, y donde ese 0 forma parte del número daría un número equivocado.
 * Solo la leen las capas de aplicación; el dominio recibe el indicativo.
 */
export const PROVISIONAL_CALLING_CODES: Readonly<Record<string, string>> =
  Object.freeze({
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
  });

/** Indicativo por defecto del país (ISO 3166-1 alfa-2), o `null` si no lo tiene. */
export function callingCodeOfCountry(country: string | null): string | null {
  const key = country?.trim().toUpperCase();
  if (!key || !Object.hasOwn(PROVISIONAL_CALLING_CODES, key)) return null;
  return PROVISIONAL_CALLING_CODES[key];
}
