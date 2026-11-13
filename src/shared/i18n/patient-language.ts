/**
 * DX-497: idioma preferido del paciente. Etiquetas BCP 47 en un subconjunto
 * canónico (el mismo que exigen los CHECK de la BD): idioma en minúsculas,
 * escritura opcional (`Hant`) y región opcional (`BR`, `419`).
 *
 * El idioma NO cambia cómo se escriben fecha y hora: eso sigue siendo el
 * locale y la zona de la sede (DX-315). Solo elige las palabras.
 */

/** El idioma de la clínica: el de la app y el de los pacientes sin preferencia. */
export const CLINIC_LANGUAGE = 'es';

export const LANGUAGE_TAG_PATTERN =
  /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;

/** Tope de idiomas en la lista de la clínica (CHECK 1..20 en la BD). */
export const MAX_PATIENT_LANGUAGES = 20;

export const LANGUAGE_TAG_MESSAGE =
  'El idioma debe ser una etiqueta BCP 47 como «en», «ca» o «pt-BR».';
export const LANGUAGE_NOT_OFFERED_MESSAGE =
  'Ese idioma no está en la lista de idiomas de los pacientes de la clínica (Ajustes › Idiomas de los pacientes).';

/**
 * Normaliza una etiqueta escrita a mano («EN», «pt_br», « ca ») a su forma
 * canónica, o `null` si no es una etiqueta del subconjunto admitido.
 */
export function canonicalLanguageTag(raw: string): string | null {
  const trimmed = raw.trim().replace(/_/g, '-');
  if (!trimmed || trimmed.length > 35) return null;
  let canonical: string;
  try {
    [canonical] = Intl.getCanonicalLocales(trimmed);
  } catch {
    return null;
  }
  return canonical && LANGUAGE_TAG_PATTERN.test(canonical) ? canonical : null;
}

/**
 * La lista de la clínica normalizada: canónica, sin repetidos, en el orden
 * dado y siempre con el idioma de la clínica (primero si no venía). `null` si
 * alguna etiqueta no es válida o pasa del tope.
 */
export function normalizePatientLanguages(
  raw: readonly string[],
): string[] | null {
  const out: string[] = [];
  for (const item of raw) {
    const tag = canonicalLanguageTag(item);
    if (!tag) return null;
    if (!out.includes(tag)) out.push(tag);
  }
  if (!out.includes(CLINIC_LANGUAGE)) out.unshift(CLINIC_LANGUAGE);
  return out.length <= MAX_PATIENT_LANGUAGES ? out : null;
}

/** Idioma base de una etiqueta (`pt-BR` → `pt`). */
export function primaryLanguage(tag: string): string {
  return tag.split('-')[0];
}

export interface ResolvedLanguage<L extends string> {
  /** Idioma del catálogo en que sale el texto. */
  language: L;
  /**
   * El idioma del paciente cuando no hay catálogo para él y el texto sale en
   * el de la clínica («sin traducción: ca → es»); `null` si no hubo caída.
   */
  fallbackFrom: string | null;
}

/**
 * Elige el idioma de un catálogo para el paciente: su etiqueta exacta, si no
 * su idioma base (`en-GB` → `en`), si no el de la clínica con la caída
 * anotada. Sin preferencia (NULL), el de la clínica sin caída.
 */
export function resolveCatalogLanguage<L extends string>(
  preferred: string | null | undefined,
  catalog: readonly L[],
  clinicLanguage: L,
): ResolvedLanguage<L> {
  if (!preferred) return { language: clinicLanguage, fallbackFrom: null };
  const exact = catalog.find((l) => l === preferred);
  if (exact) return { language: exact, fallbackFrom: null };
  const base = catalog.find((l) => l === primaryLanguage(preferred));
  if (base) return { language: base, fallbackFrom: null };
  return { language: clinicLanguage, fallbackFrom: preferred };
}
