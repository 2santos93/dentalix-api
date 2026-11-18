import { canonicalLanguageTag, LANGUAGE_TAG_MESSAGE } from './patient-language';
import { LINK_TLDS } from './link-tlds';

/**
 * Texto plano que la clínica escribe para sus pacientes, uno por idioma: las
 * indicaciones previas a la cita (DX-564) y la descripción del catálogo para
 * el paciente (DX-560). Reglas puras compartidas: cada uso pone su tope y sus
 * mensajes; la normalización y la detección de enlaces o HTML son las mismas.
 */

/** `http://`, `https://`, `www.` o algo con aspecto de etiqueta (`<b>`, `</p>`, `<a href…>`, `<!--`). */
const LINK_OR_HTML = /https?:\/\/|www\.|<\s*\/?\s*[a-z!][^<>]*>/i;

/**
 * Un dominio que WhatsApp, Gmail o iOS convertirían en enlace aunque no lleve
 * `http`: letra o cifra, un punto SIN espacio y una palabra de 2 o más letras
 * seguida de fin, espacio, `/`, `:`, `#` o puntuación. Solo cuenta si esa
 * palabra es un TLD de la lista cerrada (`LINK_TLDS`), sin distinguir
 * mayúsculas: marca «ejemplo.com/login», «EJEMPLO.COM», «x.com», «bit.ly»,
 * «tienda.com.ve»; no marca «6h.Trae», «Dr.Pérez», «Sr.García», «p.ej.»,
 * «a.m.» (una letra), «10.30 h» ni «1.5 ml» (cifras). Ver `link-tlds.ts`.
 */
const DOT_WORD = /(?<=[\p{L}\p{N}])\.(\p{L}{2,})(?=$|[\s/:#?.,;!)\]}"'»…])/gu;

function hasBareDomain(text: string): boolean {
  for (const match of text.matchAll(DOT_WORD)) {
    if (LINK_TLDS.has(match[1].toLowerCase())) return true;
  }
  return false;
}

/** Una IPv4 («192.168.0.1/login»): también se convierte en enlace. */
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;

/** Una dirección de email («x@ejemplo.com»): también se convierte en enlace. */
const EMAIL_ADDRESS = /\S+@\S+\.\S+/;

/** U+200D (une los emojis compuestos): el único carácter de formato que queda. */
const ZERO_WIDTH_JOINER = String.fromCharCode(0x200d);

/**
 * Un texto tal como se guarda: saltos de línea `\n` (como mucho dos seguidos),
 * tabuladores como espacio, sin otros caracteres de control ni de formato
 * (salvo U+200D) y recortado. Los saltos se conservan.
 */
export function normalizePatientPlainText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, ' ')
      .replace(/[\p{Cc}\u2028\u2029]/gu, (c) => (c === '\n' ? c : ''))
      // Formato invisible (espacio de ancho cero, guion suave, U+202E…): sirve
      // para colar un enlace partido.
      .replace(/\p{Cf}/gu, (c) => (c === ZERO_WIDTH_JOINER ? c : ''))
      // Sin espacios al final de línea y como mucho una línea en blanco seguida.
      .replace(/[ \xa0]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** ¿Lleva el texto (ya normalizado) un enlace, un dominio, una IP, un email o HTML? */
export function hasLinkOrHtml(text: string): boolean {
  return (
    LINK_OR_HTML.test(text) ||
    hasBareDomain(text) ||
    IPV4.test(text) ||
    EMAIL_ADDRESS.test(text)
  );
}

export interface PatientPlainTextEntry {
  language: string;
  text: string;
}

/** Topes y mensajes (400 en español) de un texto por idioma. */
export interface PatientPlainTextRules {
  /** Caracteres de cada texto, tras recortar. */
  textMax: number;
  maxLanguages: number;
  /** Bytes del mapa en JSON (UTF-8): la red del CHECK de tamaño. */
  totalBytesMax: number;
  messages: {
    tooMany: string;
    repeated: string;
    languageNotOffered: string;
    tooLong: string;
    noLinks: string;
    tooLarge: string;
  };
}

/**
 * Valida la lista que llega de la API y la convierte en el mapa que se guarda
 * (`{ idioma: texto }`). La lista es el mapa entero: un idioma que no viene se
 * quita. Reglas, en orden:
 *  - como mucho `maxLanguages` entradas;
 *  - etiqueta BCP 47 válida (se canoniza: «EN» → «en»);
 *  - sin idiomas repetidos;
 *  - texto vacío tras recortar → se descarta esa entrada;
 *  - el idioma debe estar en la lista de la clínica, salvo que su texto sea
 *    exactamente el ya guardado (la web puede devolver lo que leyó aunque la
 *    clínica haya retirado ese idioma después: retirarlo no borra el texto);
 *  - hasta `textMax` caracteres; sin enlaces ni HTML;
 *  - el mapa entero, hasta `totalBytesMax` bytes de JSON.
 */
export function patientPlainTextFromEntries(
  entries: readonly PatientPlainTextEntry[],
  context: {
    patientLanguages: readonly string[];
    current: Readonly<Record<string, string>>;
  },
  rules: PatientPlainTextRules,
): { map: Record<string, string> } | { error: string } {
  const { messages } = rules;
  if (entries.length > rules.maxLanguages) {
    return { error: messages.tooMany };
  }
  const map: Record<string, string> = {};
  const seen = new Set<string>();
  for (const entry of entries) {
    const language = canonicalLanguageTag(entry.language);
    if (!language) return { error: LANGUAGE_TAG_MESSAGE };
    if (seen.has(language)) return { error: messages.repeated };
    seen.add(language);
    const text = normalizePatientPlainText(entry.text);
    if (text === '') continue;
    if (
      !context.patientLanguages.includes(language) &&
      context.current[language] !== text
    ) {
      return { error: messages.languageNotOffered };
    }
    if ([...text].length > rules.textMax) return { error: messages.tooLong };
    if (hasLinkOrHtml(text)) return { error: messages.noLinks };
    map[language] = text;
  }
  if (Buffer.byteLength(JSON.stringify(map), 'utf8') > rules.totalBytesMax) {
    return { error: messages.tooLarge };
  }
  return { map };
}
