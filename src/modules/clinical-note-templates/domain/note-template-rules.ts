/**
 * Reglas de las plantillas de evolución (DX-170). Puras: las comparten los
 * casos de uso (400 en español), los tests y la siembra de ejemplos; la
 * migración repite los topes como CHECK, que es la red si algo se saltara la
 * API.
 *
 * Un marcador `{{Etiqueta}}` del cuerpo se rellena con la respuesta a la
 * pregunta de esa etiqueta (sin distinguir mayúsculas ni espacios de más).
 */

export const NOTE_TEMPLATE_NAME_MAX = 80;
export const NOTE_TEMPLATE_CATEGORY_MAX = 60;
export const NOTE_TEMPLATE_BODY_MAX = 5000;
export const NOTE_PROMPTS_MAX = 20;
export const NOTE_PROMPT_LABEL_MAX = 50;
export const NOTE_PROMPT_OPTIONS_MAX = 20;
export const NOTE_PROMPT_OPTION_MAX = 80;
export const NOTE_PROMPT_DEFAULT_MAX = 200;
export const NOTE_ANSWER_TEXT_MAX = 1000;

/** Lo que queda en el texto cuando una pregunta se omite o no tiene respuesta. */
export const SKIPPED_ANSWER = '[sin respuesta]';

export type NotePromptType = 'ONE' | 'MULTI' | 'TEXT';

export interface NotePromptDraft {
  label: string;
  type: NotePromptType;
  options: string[];
  defaultValue: string | null;
}

export interface NoteTemplateDraft {
  name: string;
  category: string | null;
  body: string;
  prompts: NotePromptDraft[];
}

/** Respuesta a una pregunta: valores elegidos o escritos, u «Omitir». */
export interface NoteAnswer {
  skipped?: boolean;
  values?: string[];
}

export type AnswerResult = { text: string } | { error: string };

const MARKER = /\{\{([^{}]*)\}\}/g;
// Caracteres de control salvo salto de línea y tabulador.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const TYPE_NAME: Record<Exclude<NotePromptType, 'TEXT'>, string> = {
  ONE: 'opción única',
  MULTI: 'opción múltiple',
};

/** Clave con la que un marcador casa con una etiqueta. */
export function promptKey(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
}

/** Etiquetas de los marcadores del cuerpo, en orden y recortadas. */
export function noteMarkers(body: string): string[] {
  return [...body.matchAll(MARKER)].map((m) => m[1].trim());
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Recorta los textos; carpeta y valor por defecto vacíos pasan a null. */
export function normalizeNoteTemplate(
  draft: NoteTemplateDraft,
): NoteTemplateDraft {
  return {
    name: draft.name.trim(),
    category: trimOrNull(draft.category),
    body: draft.body.trim(),
    prompts: draft.prompts.map((p) => ({
      label: p.label.trim(),
      type: p.type,
      options: p.options.map((o) => o.trim()),
      defaultValue: trimOrNull(p.defaultValue),
    })),
  };
}

function promptError(prompt: NotePromptDraft): string | null {
  const { label, type, options, defaultValue } = prompt;
  if (label === '') return 'Cada pregunta necesita una etiqueta';
  if (label.length > NOTE_PROMPT_LABEL_MAX) {
    return `La etiqueta «${label}» no puede tener más de ${NOTE_PROMPT_LABEL_MAX} caracteres`;
  }
  if (/[{}]/.test(label)) {
    return `La etiqueta «${label}» no puede llevar llaves { }`;
  }
  if (type === 'TEXT') {
    if (options.length > 0) {
      return `La pregunta «${label}» es de texto libre y no lleva opciones`;
    }
    if (defaultValue && defaultValue.length > NOTE_PROMPT_DEFAULT_MAX) {
      return `El valor por defecto de «${label}» no puede tener más de ${NOTE_PROMPT_DEFAULT_MAX} caracteres`;
    }
    return null;
  }
  if (options.length === 0 || options.some((o) => o === '')) {
    return `La pregunta «${label}» es de ${TYPE_NAME[type]} y necesita al menos una opción (sin opciones vacías)`;
  }
  if (options.length > NOTE_PROMPT_OPTIONS_MAX) {
    return `La pregunta «${label}» admite como máximo ${NOTE_PROMPT_OPTIONS_MAX} opciones`;
  }
  const seen = new Set<string>();
  for (const option of options) {
    if (option.length > NOTE_PROMPT_OPTION_MAX) {
      return `La opción «${option}» de «${label}» no puede tener más de ${NOTE_PROMPT_OPTION_MAX} caracteres`;
    }
    const key = option.toLocaleLowerCase('es');
    if (seen.has(key)) {
      return `La opción «${option}» está repetida en «${label}»`;
    }
    seen.add(key);
  }
  if (defaultValue !== null && !options.includes(defaultValue)) {
    return `El valor por defecto de «${label}» tiene que ser una de sus opciones`;
  }
  return null;
}

/**
 * Primer problema de una plantilla (ya normalizada), o null si es válida. El
 * orden importa: primero lo que el usuario ve arriba del formulario.
 */
export function noteTemplateError(raw: NoteTemplateDraft): string | null {
  const draft = normalizeNoteTemplate(raw);
  if (draft.name === '')
    return 'El nombre de la plantilla no puede estar vacío';
  if (draft.name.length > NOTE_TEMPLATE_NAME_MAX) {
    return `El nombre de la plantilla no puede tener más de ${NOTE_TEMPLATE_NAME_MAX} caracteres`;
  }
  if (draft.category && draft.category.length > NOTE_TEMPLATE_CATEGORY_MAX) {
    return `La carpeta no puede tener más de ${NOTE_TEMPLATE_CATEGORY_MAX} caracteres`;
  }
  if (draft.body === '') return 'El texto de la plantilla no puede estar vacío';
  if (draft.body.length > NOTE_TEMPLATE_BODY_MAX) {
    return `El texto de la plantilla no puede tener más de ${NOTE_TEMPLATE_BODY_MAX} caracteres`;
  }
  if (draft.prompts.length > NOTE_PROMPTS_MAX) {
    return `Una plantilla admite como máximo ${NOTE_PROMPTS_MAX} preguntas`;
  }

  const keys = new Set<string>();
  for (const prompt of draft.prompts) {
    const error = promptError(prompt);
    if (error) return error;
    const key = promptKey(prompt.label);
    if (keys.has(key)) {
      return `Hay dos preguntas con la etiqueta «${prompt.label}»`;
    }
    keys.add(key);
  }

  const markers = noteMarkers(draft.body);
  const used = new Set<string>();
  for (const marker of markers) {
    if (marker === '') {
      return 'Hay un marcador vacío {{ }} en el texto: escribe dentro la etiqueta de una pregunta';
    }
    const key = promptKey(marker);
    if (!keys.has(key)) {
      return `El marcador {{${marker}}} no corresponde a ninguna pregunta: crea una pregunta con esa etiqueta o quítalo del texto`;
    }
    used.add(key);
  }
  const unused = draft.prompts.find((p) => !used.has(promptKey(p.label)));
  if (unused) {
    return `La pregunta «${unused.label}» no aparece en el texto: añade el marcador {{${unused.label}}}`;
  }
  return null;
}

/** «a», «a y b», «a, b y c». */
function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

function clean(value: string): string {
  return value.replace(CONTROL_CHARS, '').trim();
}

/**
 * Texto con el que una respuesta rellena el marcador de su pregunta.
 * - Sin respuesta (`undefined`): el valor por defecto o, si no hay, el hueco
 *   marcado «[sin respuesta]».
 * - «Omitir» o una respuesta vacía: el hueco marcado, aunque haya defecto.
 * - ONE/MULTI: solo opciones de la pregunta (MULTI, en el orden de opciones).
 */
export function answerText(
  prompt: NotePromptDraft,
  answer: NoteAnswer | undefined,
): AnswerResult {
  if (answer === undefined) {
    return { text: prompt.defaultValue ?? SKIPPED_ANSWER };
  }
  const values = (answer.values ?? []).map(clean).filter((v) => v !== '');
  if (answer.skipped || values.length === 0) return { text: SKIPPED_ANSWER };

  if (prompt.type === 'TEXT') {
    if (values.length > 1) {
      return { error: `«${prompt.label}» admite un solo texto` };
    }
    if (values[0].length > NOTE_ANSWER_TEXT_MAX) {
      return {
        error: `La respuesta a «${prompt.label}» no puede tener más de ${NOTE_ANSWER_TEXT_MAX} caracteres`,
      };
    }
    return { text: values[0] };
  }

  const unknown = values.find((v) => !prompt.options.includes(v));
  if (unknown !== undefined) {
    return { error: `«${unknown}» no es una opción de «${prompt.label}»` };
  }
  if (prompt.type === 'ONE') {
    if (values.length > 1) {
      return { error: `«${prompt.label}» admite una sola opción` };
    }
    return { text: values[0] };
  }
  const chosen = new Set(values);
  return { text: listJoin(prompt.options.filter((o) => chosen.has(o))) };
}

/**
 * Sustituye cada marcador por el texto de su pregunta en UNA pasada: lo que
 * trae una respuesta (otro `{{…}}`, `$&`, HTML) se copia literal y nunca se
 * vuelve a interpretar. Un marcador sin texto queda «[sin respuesta]».
 */
export function composeNote(
  body: string,
  filled: { label: string; text: string }[],
): string {
  const byKey = new Map(filled.map((f) => [promptKey(f.label), f.text]));
  return body.replace(
    MARKER,
    (_match, label: string) => byKey.get(promptKey(label)) ?? SKIPPED_ANSWER,
  );
}
