import {
  localizedTextEntries,
  resolveLocalizedText,
  type LocalizedTextMap,
} from '../../../shared/i18n/localized-text';
import {
  CLINIC_LANGUAGE,
  resolveCatalogLanguage,
} from '../../../shared/i18n/patient-language';
import {
  patientPlainTextFromEntries,
  type PatientPlainTextEntry,
  type PatientPlainTextRules,
} from '../../../shared/i18n/patient-plain-text';

/**
 * DX-560: «Descripción para el paciente» de un ítem del catálogo, una por
 * idioma de los pacientes de la clínica (`{ "es": "Limpieza profunda…" }`).
 * Es lo que lee el paciente en la presentación del plan y en el enlace de
 * aceptación en vez del nombre técnico. Reglas puras; la migración repite el
 * tipo (objeto) y el tamaño como CHECK, que es la red si algo se saltara la
 * API.
 */

/** Caracteres de cada texto, tras recortar. */
export const PATIENT_DESCRIPTION_TEXT_MAX = 300;
/** Idiomas por ítem (la lista de la clínica admite hasta 20). */
export const PATIENT_DESCRIPTION_MAX_LANGUAGES = 10;
/**
 * Bytes del mapa en JSON (UTF-8). El CHECK de la BD admite 8192 de jsonb;
 * como en DX-564, con 8000 bytes de JSON el jsonb queda por debajo.
 */
export const PATIENT_DESCRIPTION_TOTAL_BYTES_MAX = 8000;

export const PATIENT_DESCRIPTION_NOT_A_LIST_MESSAGE =
  'La descripción para el paciente debe ir en una lista.';
export const PATIENT_DESCRIPTION_TOO_MANY_MESSAGE = `La descripción para el paciente admite como mucho ${PATIENT_DESCRIPTION_MAX_LANGUAGES} idiomas.`;
export const PATIENT_DESCRIPTION_REPEATED_MESSAGE =
  'Ese idioma está repetido en la descripción para el paciente.';
export const PATIENT_DESCRIPTION_LANGUAGE_NOT_OFFERED_MESSAGE =
  'Ese idioma no está entre los idiomas de los pacientes de la clínica.';
export const PATIENT_DESCRIPTION_TOO_LONG_MESSAGE = `La descripción para el paciente no puede tener más de ${PATIENT_DESCRIPTION_TEXT_MAX} caracteres.`;
export const PATIENT_DESCRIPTION_NO_LINKS_MESSAGE =
  'La descripción para el paciente no admite enlaces ni HTML: escríbela como texto.';
export const PATIENT_DESCRIPTION_TOO_LARGE_MESSAGE =
  'La descripción para el paciente es demasiado larga en conjunto: acorta alguno de los idiomas.';

const PATIENT_DESCRIPTION_RULES: PatientPlainTextRules = {
  textMax: PATIENT_DESCRIPTION_TEXT_MAX,
  maxLanguages: PATIENT_DESCRIPTION_MAX_LANGUAGES,
  totalBytesMax: PATIENT_DESCRIPTION_TOTAL_BYTES_MAX,
  messages: {
    tooMany: PATIENT_DESCRIPTION_TOO_MANY_MESSAGE,
    repeated: PATIENT_DESCRIPTION_REPEATED_MESSAGE,
    languageNotOffered: PATIENT_DESCRIPTION_LANGUAGE_NOT_OFFERED_MESSAGE,
    tooLong: PATIENT_DESCRIPTION_TOO_LONG_MESSAGE,
    noLinks: PATIENT_DESCRIPTION_NO_LINKS_MESSAGE,
    tooLarge: PATIENT_DESCRIPTION_TOO_LARGE_MESSAGE,
  },
};

export type PatientDescriptionEntry = PatientPlainTextEntry;

/**
 * La lista que llega de la API → el mapa que se guarda. La lista es el mapa
 * entero (un idioma que no viene se quita; vacía = sin descripción). Mismas
 * reglas que las indicaciones de DX-564 (idiomas de la clínica, sin repetir,
 * vacías descartadas, sin enlaces ni HTML) con su tope de 300 caracteres.
 */
export function patientDescriptionFromEntries(
  entries: readonly PatientDescriptionEntry[],
  context: {
    patientLanguages: readonly string[];
    current: Readonly<Record<string, string>>;
  },
): { map: Record<string, string> } | { error: string } {
  return patientPlainTextFromEntries(
    entries,
    context,
    PATIENT_DESCRIPTION_RULES,
  );
}

/** El mapa guardado a partir de la lista de la entidad (para comparar). */
export function patientDescriptionMap(
  entries: readonly PatientDescriptionEntry[],
): Record<string, string> {
  return Object.fromEntries(entries.map((e) => [e.language, e.text]));
}

/** La lista que sale por la API: español primero y luego alfabético. */
export function patientDescriptionEntries(
  map: LocalizedTextMap,
): PatientDescriptionEntry[] {
  return localizedTextEntries(map);
}

/** Lo que el resolvedor necesita de un ítem del catálogo. */
export interface PatientLabelSource {
  labelEs: string;
  labelEn: string | null;
  labelPt: string | null;
  patientDescription: LocalizedTextMap;
}

/** «Procedimiento»: un ítem sin catálogo (nunca un código ni un id). */
export const PATIENT_LABEL_FALLBACK = 'Procedimiento';

/**
 * El texto que lee el paciente para un procedimiento, en su idioma:
 *  1. la descripción para el paciente en su idioma exacto, si no en su idioma
 *     base (`en-GB` → `en`), si no en español (la regla de DX-497/DX-564);
 *  2. si no hay ninguna, el nombre del catálogo en su idioma con la misma
 *     regla (`labelEn` / `labelPt` si existen; si no `labelEs`).
 * Nunca un código ni un id: sin ítem de catálogo, «Procedimiento».
 */
export function patientProcedureLabel(
  item: PatientLabelSource | null | undefined,
  patientLanguage: string | null | undefined,
): string {
  if (!item) return PATIENT_LABEL_FALLBACK;
  const described = resolveLocalizedText(
    item.patientDescription,
    patientLanguage,
  );
  if (described) return described.text;
  const labels: Record<string, string> = { [CLINIC_LANGUAGE]: item.labelEs };
  if (item.labelEn?.trim()) labels.en = item.labelEn;
  if (item.labelPt?.trim()) labels.pt = item.labelPt;
  const { language } = resolveCatalogLanguage(
    patientLanguage,
    Object.keys(labels),
    CLINIC_LANGUAGE,
  );
  const label = labels[language]?.trim();
  return label ? label : item.labelEs.trim() || PATIENT_LABEL_FALLBACK;
}

/** El idioma de la presentación: el del paciente o, sin preferencia, el de la clínica. */
export function presentationLanguage(
  patientLanguage: string | null | undefined,
): string {
  return patientLanguage || CLINIC_LANGUAGE;
}
