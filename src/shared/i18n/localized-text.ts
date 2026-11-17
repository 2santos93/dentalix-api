import { CLINIC_LANGUAGE, resolveCatalogLanguage } from './patient-language';

/**
 * DX-564: un texto que la clínica escribe en varios idiomas de sus pacientes
 * (`{ "es": "…", "en": "…" }`), p. ej. las indicaciones previas de un tipo de
 * cita. Las claves son etiquetas BCP 47 canónicas.
 */
export type LocalizedTextMap = Readonly<Record<string, string>>;

export interface ResolvedLocalizedText {
  text: string;
  /** Idioma en que sale el texto. */
  language: string;
  /**
   * El idioma del paciente cuando no hay texto para él y sale el de la
   * clínica («en → es»); `null` si no hubo caída.
   */
  fallbackFrom: string | null;
}

/**
 * Elige el texto para el paciente con la misma regla que los catálogos de
 * DX-497: su idioma exacto, si no su idioma base (`en-GB` → `en`), si no el
 * de la clínica (`es`). Si tampoco hay texto en español, nada (`null`): no se
 * envía un texto en un tercer idioma que el paciente no eligió.
 */
export function resolveLocalizedText(
  map: LocalizedTextMap | null | undefined,
  patientLanguage: string | null | undefined,
): ResolvedLocalizedText | null {
  if (!map) return null;
  const available = Object.keys(map).filter(
    (language) => typeof map[language] === 'string' && map[language] !== '',
  );
  const { language, fallbackFrom } = resolveCatalogLanguage(
    patientLanguage,
    available,
    CLINIC_LANGUAGE,
  );
  const text = available.includes(language) ? map[language] : undefined;
  if (text === undefined) return null;
  return { text, language, fallbackFrom };
}

/**
 * La lista de variantes que sale por la API: el idioma de la clínica primero
 * y luego el resto en orden alfabético de etiqueta. Sin las vacías.
 */
export function localizedTextEntries(
  map: LocalizedTextMap | null | undefined,
): { language: string; text: string }[] {
  if (!map) return [];
  return Object.entries(map)
    .filter(([, text]) => typeof text === 'string' && text !== '')
    .sort(([a], [b]) => {
      if (a === CLINIC_LANGUAGE) return b === CLINIC_LANGUAGE ? 0 : -1;
      if (b === CLINIC_LANGUAGE) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .map(([language, text]) => ({ language, text }));
}

/** El mapa leído de una columna jsonb: solo las entradas texto → texto. */
export function localizedTextMapFromJson(value: unknown): LocalizedTextMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1] !== '',
    ),
  );
}
