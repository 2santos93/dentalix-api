import {
  localizedTextEntries,
  type LocalizedTextMap,
} from '../../../shared/i18n/localized-text';
import {
  CLINIC_LANGUAGE,
  primaryLanguage,
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

/** El texto para el paciente y el idioma en que sale (etiqueta BCP 47). */
export interface PatientProcedureLabel {
  label: string;
  language: string;
}

/** El nombre del catálogo en otro idioma que el español, si lo tiene. */
function catalogLabelIn(
  item: PatientLabelSource,
  language: string,
): string | null {
  const label =
    language === 'en' ? item.labelEn : language === 'pt' ? item.labelPt : null;
  const trimmed = label?.trim();
  return trimmed ? trimmed : null;
}

/**
 * El texto que lee el paciente para un procedimiento, con el idioma en que
 * sale (DX-560, revisión: el nombre en su idioma gana a la descripción en
 * otro):
 *  1. la descripción en su idioma exacto (`pt-BR`);
 *  2. la descripción en su idioma base (`en-GB` → `en`);
 *  3. el nombre del catálogo en ese idioma (`labelEn` / `labelPt`), si existe;
 *  4. la descripción en español;
 *  5. `labelEs`;
 *  6. «Procedimiento» (sin ítem de catálogo). Nunca un código ni un id.
 * Sin idioma preferido, el del paciente es el español (4 → 5 → 6).
 */
export function patientProcedureLabel(
  item: PatientLabelSource | null | undefined,
  patientLanguage: string | null | undefined,
): PatientProcedureLabel {
  if (!item) {
    return { label: PATIENT_LABEL_FALLBACK, language: CLINIC_LANGUAGE };
  }
  const description = (language: string): string | null => {
    const text = item.patientDescription[language];
    return typeof text === 'string' && text.trim() !== '' ? text : null;
  };
  if (patientLanguage && patientLanguage !== CLINIC_LANGUAGE) {
    const exact = description(patientLanguage);
    if (exact) return { label: exact, language: patientLanguage };
    const base = primaryLanguage(patientLanguage);
    if (base !== CLINIC_LANGUAGE) {
      const baseText = base !== patientLanguage ? description(base) : null;
      if (baseText) return { label: baseText, language: base };
      const named = catalogLabelIn(item, base);
      if (named) return { label: named, language: base };
    }
  }
  const spanish = description(CLINIC_LANGUAGE);
  if (spanish) return { label: spanish, language: CLINIC_LANGUAGE };
  const labelEs = item.labelEs.trim();
  return {
    label: labelEs || PATIENT_LABEL_FALLBACK,
    language: CLINIC_LANGUAGE,
  };
}

/** El idioma de la presentación: el del paciente o, sin preferencia, el de la clínica. */
export function presentationLanguage(
  patientLanguage: string | null | undefined,
): string {
  return patientLanguage || CLINIC_LANGUAGE;
}
