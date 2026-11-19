import {
  hasLinkOrHtml,
  normalizePatientPlainText,
} from '../../../shared/i18n/patient-plain-text';
import {
  MESSAGE_CATALOG,
  MESSAGE_SUBJECT_MAX,
  messageBodyMax,
  messageChannelSpec,
  type MessageChannel,
  type MessageKey,
  type MessageText,
} from './message-catalog';
import {
  FORBIDDEN_MESSAGE_VARIABLES,
  isMessageVariable,
  type MessageValues,
  type MessageVariable,
} from './message-variables';

/**
 * DX-565: el ÚNICO motor de los textos de la clínica. Texto plano con
 * `{variable}` y tramos opcionales «[ con {profesional}]» (salen solo si todas
 * sus variables tienen valor). La sustitución es de una pasada sobre el texto
 * de la clínica, nunca sobre un valor ya sustituido: un nombre «{enlace}» o
 * «[x]» sale tal cual. El HTML lo escapa después el layout del email.
 */

type Piece = { kind: 'text'; text: string } | { kind: 'var'; name: string };
type Token = Piece | { kind: 'optional'; pieces: Piece[] };

export const MESSAGE_BRACES_MESSAGE =
  'Revisa las llaves: cada variable va entre llaves, como {paciente}.';
export const MESSAGE_BRACKETS_MESSAGE =
  'Revisa los corchetes: un tramo opcional va entre corchetes y lleva una variable, como [ con {profesional}].';
export const MESSAGE_MULTILINE_OPTIONAL_MESSAGE =
  'Un tramo entre corchetes no puede ocupar varias líneas.';
export const MESSAGE_BODY_EMPTY_MESSAGE = 'Escribe el texto del mensaje.';
export const MESSAGE_SUBJECT_EMPTY_MESSAGE = 'Escribe el asunto del email.';
export const MESSAGE_WHATSAPP_SUBJECT_MESSAGE =
  'Un mensaje de WhatsApp no lleva asunto.';
export const MESSAGE_EMAIL_LINKS_MESSAGE =
  'El texto no puede llevar enlaces, direcciones web, correos ni HTML: el enlace lo pone el botón del email.';
export const MESSAGE_WHATSAPP_LINKS_MESSAGE =
  'El texto no puede llevar enlaces, direcciones web, correos ni HTML: el enlace va con {enlace}.';

type ParseResult =
  { ok: true; tokens: Token[] } | { ok: false; message: string };

function parse(text: string): ParseResult {
  const tokens: Token[] = [];
  let optional: Piece[] | null = null;
  let literal = '';
  const flush = () => {
    if (!literal) return;
    (optional ?? tokens).push({ kind: 'text', text: literal });
    literal = '';
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '{') {
      const end = text.indexOf('}', i + 1);
      const name = end === -1 ? '' : text.slice(i + 1, end);
      if (end === -1 || name.trim() === '' || /[{\n[\]]/.test(name)) {
        return { ok: false, message: MESSAGE_BRACES_MESSAGE };
      }
      flush();
      (optional ?? tokens).push({ kind: 'var', name: name.trim() });
      i = end;
    } else if (c === '}') {
      return { ok: false, message: MESSAGE_BRACES_MESSAGE };
    } else if (c === '[') {
      if (optional) return { ok: false, message: MESSAGE_BRACKETS_MESSAGE };
      flush();
      optional = [];
    } else if (c === ']') {
      if (!optional) return { ok: false, message: MESSAGE_BRACKETS_MESSAGE };
      flush();
      if (!optional.some((p) => p.kind === 'var')) {
        return { ok: false, message: MESSAGE_BRACKETS_MESSAGE };
      }
      tokens.push({ kind: 'optional', pieces: optional });
      optional = null;
    } else {
      if (c === '\n' && optional) {
        return { ok: false, message: MESSAGE_MULTILINE_OPTIONAL_MESSAGE };
      }
      literal += c;
    }
  }
  if (optional) return { ok: false, message: MESSAGE_BRACKETS_MESSAGE };
  flush();
  return { ok: true, tokens };
}

function variablesOf(tokens: readonly Token[]): string[] {
  return tokens.flatMap((t) =>
    t.kind === 'var'
      ? [t.name]
      : t.kind === 'optional'
        ? t.pieces.flatMap((p) => (p.kind === 'var' ? [p.name] : []))
        : [],
  );
}

/** El texto sin las variables (para buscar enlaces o HTML escritos a mano). */
function literalText(tokens: readonly Token[]): string {
  const pieceText = (p: Piece) => (p.kind === 'text' ? p.text : ' ');
  return tokens
    .map((t) =>
      t.kind === 'optional' ? t.pieces.map(pieceText).join('') : pieceText(t),
    )
    .join('');
}

function valueOf(values: MessageValues, name: string): string {
  if (!isMessageVariable(name)) return '';
  const value = values[name];
  return value && value.trim() !== '' ? value : '';
}

function renderTokens(tokens: readonly Token[], values: MessageValues): string {
  const out: { text: string; fromVariable: boolean }[] = [];
  const push = (raw: string, fromVariable: boolean) => {
    let text = raw;
    // Como `endSentence`: una hora «9:30 a. m.» seguida de «.» no dobla el punto.
    const last = out[out.length - 1];
    if (
      !fromVariable &&
      text.startsWith('.') &&
      last?.fromVariable &&
      last.text.endsWith('.')
    ) {
      text = text.slice(1);
    }
    if (text) out.push({ text, fromVariable });
  };
  const pushPiece = (p: Piece) =>
    p.kind === 'text'
      ? push(p.text, false)
      : push(valueOf(values, p.name), true);
  for (const token of tokens) {
    if (token.kind !== 'optional') {
      pushPiece(token);
      continue;
    }
    const complete = token.pieces.every(
      (p) => p.kind === 'text' || valueOf(values, p.name) !== '',
    );
    if (complete) token.pieces.forEach(pushPiece);
  }
  return out.map((p) => p.text).join('');
}

export type MessageTemplateField = 'subject' | 'body';

export type MessageValidation =
  | { ok: true; text: MessageText }
  | { ok: false; field: MessageTemplateField; message: string };

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function checkVariables(
  tokens: readonly Token[],
  allowed: readonly MessageVariable[],
  where: string,
): string | null {
  for (const name of variablesOf(tokens)) {
    if (FORBIDDEN_MESSAGE_VARIABLES.includes(name.toLowerCase())) {
      return `{${name}} no se puede usar en ${where}: los mensajes al paciente no llevan importes ni datos clínicos.`;
    }
    if (!isMessageVariable(name)) return `La variable {${name}} no existe.`;
    if (!allowed.includes(name)) {
      return `{${name}} no se puede usar en ${where}.`;
    }
  }
  return null;
}

const chars = (text: string) => [...text].length;

/** El asunto se guarda en una línea. */
export function normalizeMessageSubject(subject: string): string {
  return normalizePatientPlainText(subject.replace(/\s*[\r\n]+\s*/g, ' '));
}

/**
 * Valida y normaliza lo que la clínica quiere guardar (o previsualizar) para
 * (clave, canal). 400 en español con el campo, en este orden: vacío, largo,
 * llaves y corchetes, variables (prohibida, desconocida, no permitida),
 * obligatorias y enlaces o HTML escritos a mano.
 */
export function validateMessageTemplate(
  key: MessageKey,
  channel: MessageChannel,
  input: { subject?: string | null; body: string },
): MessageValidation {
  const spec = messageChannelSpec(key, channel);
  if (!spec) throw new Error(`${key} no se envía por ${channel}`);
  const noun = MESSAGE_CATALOG[key].noun;
  const linksMessage =
    channel === 'EMAIL'
      ? MESSAGE_EMAIL_LINKS_MESSAGE
      : MESSAGE_WHATSAPP_LINKS_MESSAGE;

  let subject: string | null = null;
  const rawSubject = input.subject ?? '';
  if (channel === 'WHATSAPP') {
    if (rawSubject.trim() !== '') {
      return {
        ok: false,
        field: 'subject',
        message: MESSAGE_WHATSAPP_SUBJECT_MESSAGE,
      };
    }
  } else {
    subject = normalizeMessageSubject(rawSubject);
    const fail = (message: string): MessageValidation => ({
      ok: false,
      field: 'subject',
      message,
    });
    if (!subject) return fail(MESSAGE_SUBJECT_EMPTY_MESSAGE);
    if (chars(subject) > MESSAGE_SUBJECT_MAX) {
      return fail(
        `El asunto no puede pasar de ${MESSAGE_SUBJECT_MAX} caracteres.`,
      );
    }
    const parsed = parse(subject);
    if (!parsed.ok) return fail(parsed.message);
    const wrong = checkVariables(
      parsed.tokens,
      spec.variables.filter((v) => v !== 'enlace'),
      'el asunto',
    );
    if (wrong) return fail(wrong);
    if (hasLinkOrHtml(literalText(parsed.tokens))) return fail(linksMessage);
  }

  const body = normalizePatientPlainText(input.body);
  const fail = (message: string): MessageValidation => ({
    ok: false,
    field: 'body',
    message,
  });
  if (!body) return fail(MESSAGE_BODY_EMPTY_MESSAGE);
  const max = messageBodyMax(channel);
  if (chars(body) > max) {
    return fail(`El texto no puede pasar de ${max} caracteres.`);
  }
  const parsed = parse(body);
  if (!parsed.ok) return fail(parsed.message);
  const wrong = checkVariables(parsed.tokens, spec.variables, noun);
  if (wrong) return fail(wrong);
  const used = new Set(variablesOf(parsed.tokens));
  // Obligatoria FUERA de un tramo opcional: un «[aquí: {enlace}]» podría no salir.
  const always = new Set(
    parsed.tokens.flatMap((t) => (t.kind === 'var' ? [t.name] : [])),
  );
  for (const required of spec.required) {
    if (!used.has(required) || !always.has(required)) {
      return fail(`${capitalize(noun)} tiene que llevar {${required}}.`);
    }
  }
  if (hasLinkOrHtml(literalText(parsed.tokens))) return fail(linksMessage);
  return { ok: true, text: { subject, body } };
}

/**
 * Renderiza un texto YA validado con los valores del envío. `null` si el
 * texto no es válido para (clave, canal) — p. ej. guardado antes de que el
 * catálogo cambiara —: quien llama cae al texto por defecto, nunca envía una
 * `{variable}` cruda.
 */
export function renderMessageTemplate(
  key: MessageKey,
  channel: MessageChannel,
  text: MessageText,
  values: MessageValues,
): MessageText | null {
  const valid = validateMessageTemplate(key, channel, text);
  if (!valid.ok) return null;
  const body = parse(valid.text.body);
  if (!body.ok) return null;
  let subject: string | null = null;
  if (valid.text.subject !== null) {
    const parsed = parse(valid.text.subject);
    if (!parsed.ok) return null;
    subject = renderTokens(parsed.tokens, values).trim();
  }
  return { subject, body: renderTokens(body.tokens, values).trim() };
}

/**
 * Los párrafos de un cuerpo de email ya renderizado: separados por una línea
 * en blanco; los vacíos (un tramo opcional que no salió) no cuentan.
 */
export function messageParagraphs(body: string): string[] {
  return body
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}
