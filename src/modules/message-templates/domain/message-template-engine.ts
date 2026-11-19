import {
  hasLinkOrHtml,
  normalizePatientPlainText,
} from '../../../shared/i18n/patient-plain-text';
import {
  MESSAGE_CATALOG,
  MESSAGE_SUBJECT_MAX,
  MESSAGE_SUBJECT_RENDERED_MAX,
  defaultMessageText,
  messageBodyMax,
  messageChannelSpec,
  messageRenderedBodyMax,
  type MessageChannel,
  type MessageChannelSpec,
  type MessageKey,
  type MessageLanguage,
  type MessageText,
} from './message-catalog';
import {
  FORBIDDEN_MESSAGE_VARIABLES,
  MESSAGE_VARIABLE_INFO,
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

/** Tras qué variables no se dobla el «.» (ver `MessageChannelSpec.endSentence`). */
const TIME_VARIABLES: readonly string[] = ['hora', 'caduca'];

function collapseAfter(spec: MessageChannelSpec): (name: string) => boolean {
  return spec.endSentence
    ? () => true
    : (name) => TIME_VARIABLES.includes(name);
}

/**
 * El render de una pasada. `value` da el valor de cada variable; un tramo
 * opcional sale si todas sus variables tienen valor, salvo que `include`
 * (variantes de la validación) lo fuerce.
 */
function renderWith(
  tokens: readonly Token[],
  value: (name: string) => string,
  collapse: (name: string) => boolean,
  include?: (optionalIndex: number) => boolean,
): string {
  const out: { text: string; variable: string | null }[] = [];
  const push = (raw: string, variable: string | null) => {
    let text = raw;
    // Como `endSentence`: una hora «9:30 a. m.» seguida de «.» no dobla el punto.
    const last = out[out.length - 1];
    if (
      variable === null &&
      text.startsWith('.') &&
      last?.variable != null &&
      collapse(last.variable) &&
      last.text.endsWith('.')
    ) {
      text = text.slice(1);
    }
    if (text) out.push({ text, variable });
  };
  const pushPiece = (p: Piece) =>
    p.kind === 'text' ? push(p.text, null) : push(value(p.name), p.name);
  let optionalIndex = 0;
  for (const token of tokens) {
    if (token.kind !== 'optional') {
      pushPiece(token);
      continue;
    }
    const index = optionalIndex++;
    const shown = include
      ? include(index)
      : token.pieces.every((p) => p.kind === 'text' || value(p.name) !== '');
    if (shown) token.pieces.forEach(pushPiece);
  }
  return out.map((p) => p.text).join('');
}

/**
 * H1: un enlace no se puede armar con los trozos del texto y las variables
 * («pagos{direccion}.com» sin dirección, «bit[{profesional}].ly» sin
 * profesional). Se busca en el texto renderizado con cada variable vacía,
 * con una letra y con su ejemplo, y con cada tramo opcional presente y
 * ausente. `{enlace}` cuenta como un espacio: su valor es el enlace legítimo.
 */
function variants(
  tokens: readonly Token[],
  collapse: (name: string) => boolean,
): string[] {
  const optionals = tokens.filter((t) => t.kind === 'optional').length;
  const as =
    (fill: (name: MessageVariable) => string) =>
    (name: string): string =>
      name === 'enlace' ? ' ' : isMessageVariable(name) ? fill(name) : '';
  const empty = as(() => '');
  const letter = as(() => 'x');
  const sample = as((name) => MESSAGE_VARIABLE_INFO[name].sample);
  const all = () => true;
  const none = () => false;
  const out = [
    renderWith(tokens, empty, collapse, none),
    renderWith(tokens, letter, collapse, all),
    renderWith(tokens, sample, collapse, all),
    renderWith(tokens, empty, collapse, all),
  ];
  for (let i = 0; i < optionals; i += 1) {
    out.push(
      renderWith(tokens, letter, collapse, (j) => j !== i),
      renderWith(tokens, letter, collapse, (j) => j === i),
      renderWith(tokens, empty, collapse, (j) => j === i),
    );
  }
  return out;
}

function hasLinkInAnyVariant(
  tokens: readonly Token[],
  collapse: (name: string) => boolean,
): boolean {
  return (
    hasLinkOrHtml(literalText(tokens)) ||
    variants(tokens, collapse).some((text) => hasLinkOrHtml(text))
  );
}

/** El largo del peor caso: cada variable a su máximo y todos los tramos. */
function worstCaseLength(
  tokens: readonly Token[],
  collapse: (name: string) => boolean,
): number {
  const longest = (name: string) =>
    isMessageVariable(name)
      ? 'x'.repeat(MESSAGE_VARIABLE_INFO[name].maxLength)
      : '';
  return chars(renderWith(tokens, longest, collapse, () => true));
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

function chars(text: string): number {
  return [...text].length;
}

/** El asunto se guarda en una línea. */
export function normalizeMessageSubject(subject: string): string {
  return normalizePatientPlainText(subject.replace(/\s*[\r\n]+\s*/g, ' '));
}

/**
 * Valida y normaliza lo que la clínica quiere guardar (o previsualizar) para
 * (clave, canal). 400 en español con el campo, en este orden: vacío, largo,
 * llaves y corchetes, variables (prohibida, desconocida, no permitida),
 * obligatorias, enlaces o HTML (también armados con las variables, H1) y el
 * largo del peor caso renderizado (H2, H12).
 */
export function validateMessageTemplate(
  key: MessageKey,
  channel: MessageChannel,
  input: { subject?: string | null; body: string },
): MessageValidation {
  const spec = messageChannelSpec(key, channel);
  if (!spec) throw new Error(`${key} no se envía por ${channel}`);
  const noun = MESSAGE_CATALOG[key].noun;
  const collapse = collapseAfter(spec);
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
    if (hasLinkInAnyVariant(parsed.tokens, collapse)) return fail(linksMessage);
    if (
      worstCaseLength(parsed.tokens, collapse) > MESSAGE_SUBJECT_RENDERED_MAX
    ) {
      return fail(renderedTooLong('El asunto', MESSAGE_SUBJECT_RENDERED_MAX));
    }
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
  if (hasLinkInAnyVariant(parsed.tokens, collapse)) return fail(linksMessage);
  const renderedMax = messageRenderedBodyMax(channel);
  if (worstCaseLength(parsed.tokens, collapse) > renderedMax) {
    return fail(renderedTooLong('El texto', renderedMax));
  }
  return { ok: true, text: { subject, body } };
}

function renderedTooLong(what: string, max: number): string {
  return `${what} puede pasar de ${max} caracteres con los datos más largos (nombres, sede, dirección): acórtalo o usa menos variables.`;
}

/** Por qué un texto guardado no salió y salió el texto por defecto. */
export type MessageFallbackReason = 'INVALID' | 'LINK' | 'TOO_LONG';

export type MessageRender =
  | { ok: true; text: MessageText }
  | { ok: false; reason: MessageFallbackReason };

function renderText(
  text: string,
  values: MessageValues,
  collapse: (name: string) => boolean,
): string | null {
  const parsed = parse(text);
  if (!parsed.ok) return null;
  return renderWith(parsed.tokens, (n) => valueOf(values, n), collapse).trim();
}

/**
 * Renderiza un texto guardado con los valores del envío y comprueba el
 * resultado. No sale (y quien llama usa el texto por defecto) si ya no es
 * válido para el catálogo (H14), si al renderizar arma un enlace o HTML que
 * el texto por defecto con los mismos datos no tiene (H1) o si se pasa de
 * los topes del texto renderizado (H2, H12). Nunca sale una `{variable}`.
 */
export function renderMessageTemplate(
  key: MessageKey,
  channel: MessageChannel,
  language: MessageLanguage,
  text: MessageText,
  values: MessageValues,
): MessageRender {
  const spec = messageChannelSpec(key, channel);
  if (!spec) return { ok: false, reason: 'INVALID' };
  const valid = validateMessageTemplate(key, channel, text);
  if (!valid.ok) return { ok: false, reason: 'INVALID' };
  const collapse = collapseAfter(spec);
  const render = (t: MessageText, v: MessageValues) => ({
    subject: t.subject === null ? null : renderText(t.subject, v, collapse),
    body: renderText(t.body, v, collapse),
  });
  const rendered = render(valid.text, values);
  if (
    rendered.body === null ||
    (valid.text.subject !== null && !rendered.subject)
  ) {
    return { ok: false, reason: 'INVALID' };
  }
  if (
    (rendered.subject !== null &&
      chars(rendered.subject) > MESSAGE_SUBJECT_RENDERED_MAX) ||
    chars(rendered.body) > messageRenderedBodyMax(channel)
  ) {
    return { ok: false, reason: 'TOO_LONG' };
  }
  // El enlace legítimo no cuenta: solo lo que arman el texto y los datos.
  const withoutLink: MessageValues = { ...values, enlace: ' ' };
  // Solo enlaces: un «<» de un dato no es HTML (el email lo escapa y en un
  // chat es texto); el HTML escrito por la clínica ya lo rechazó la validación.
  const linked = (r: { subject: string | null; body: string | null }) =>
    hasLinkOrHtml(`${r.subject ?? ''}\n${r.body ?? ''}`.replace(/[<>]/g, ' '));
  if (linked(render(valid.text, withoutLink))) {
    const fallback = defaultMessageText(key, channel, language);
    if (!fallback || !linked(render(fallback, withoutLink))) {
      return { ok: false, reason: 'LINK' };
    }
  }
  return {
    ok: true,
    text: { subject: rendered.subject, body: rendered.body },
  };
}

/** Por qué un texto guardado no saldría hoy (para el GET), o null. */
export function storedMessageTemplateProblem(
  key: MessageKey,
  channel: MessageChannel,
  text: MessageText,
): string | null {
  const valid = validateMessageTemplate(key, channel, text);
  return valid.ok ? null : valid.message;
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
