import { crc32 } from 'node:zlib';

/**
 * DX-019: el logo de la clínica (PNG, JPEG o SVG, hasta 1 MB). Es PÚBLICO por
 * diseño (lo enseñan el login, los documentos y las páginas del paciente), así
 * que nunca se guarda lo que manda el navegador tal cual (SEC-012):
 *
 * - El tipo sale de los BYTES (magic bytes), no de la etiqueta del multipart
 *   ni de la extensión del nombre.
 * - Se RE-ESCRIBE desde lo que se validó: PNG solo con sus trozos de imagen
 *   (CRC comprobado), JPEG solo con sus segmentos de imagen; se cae lo demás
 *   (metadatos, EXIF con la ubicación, comentarios, y cualquier cosa pegada
 *   detrás del final de la imagen, que es como se arma un «políglota»). El
 *   SVG se parsea y se vuelve a serializar con una lista blanca de elementos
 *   y atributos: nada de scripts, eventos, `foreignObject`, enlaces externos,
 *   `<style>` ni entidades.
 *
 * Es una re-escritura del contenedor, no una re-codificación de píxeles (la
 * API no lleva una librería de imagen): los píxeles son los del fichero.
 * Puro y sin dependencias; un fallo es un 400 con el mensaje en español.
 */

export const LOGO_MAX_BYTES = 1024 * 1024;
/** Lado máximo de un PNG o JPEG: más es un logo absurdo (o una bomba de descompresión). */
export const LOGO_MAX_SIDE = 8192;

export type LogoContentType = 'image/png' | 'image/jpeg' | 'image/svg+xml';

export const LOGO_EXTENSION: Record<LogoContentType, 'png' | 'jpg' | 'svg'> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
};

export const LOGO_MESSAGES = {
  empty: 'El logo está vacío.',
  tooLarge: 'El logo supera el máximo de 1 MB.',
  type: 'El logo debe ser una imagen PNG, JPG o SVG.',
  damaged:
    'El logo no es una imagen válida o está dañado. Expórtalo de nuevo y vuelve a subirlo.',
  dimensions: `El logo es demasiado grande: como mucho ${LOGO_MAX_SIDE} × ${LOGO_MAX_SIDE} píxeles.`,
  svg: 'El SVG no se puede usar como logo: debe ser un dibujo SVG sencillo, sin scripts, enlaces ni imágenes incrustadas.',
} as const;

export type SanitizedLogo =
  | { ok: true; contentType: LogoContentType; bytes: Buffer }
  | { ok: false; message: string };

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

class LogoError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
  }
}

/** Tipo por los bytes: PNG, JPEG o (texto que empieza por XML/`<svg`) SVG. */
export function sniffLogo(bytes: Buffer): LogoContentType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    return 'image/png';
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  const head = bytes
    .subarray(0, 1024)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (
    /^<\?xml[\s?]/.test(head) ||
    /^<svg[\s>/]/.test(head) ||
    /^<!--/.test(head)
  ) {
    return /<svg[\s>/]/.test(bytes.toString('utf8')) ? 'image/svg+xml' : null;
  }
  return null;
}

/** Valida y re-escribe el logo. Nunca lanza: `{ ok: false, message }`. */
export function sanitizeLogo(bytes: Buffer): SanitizedLogo {
  if (bytes.length === 0) return { ok: false, message: LOGO_MESSAGES.empty };
  if (bytes.length > LOGO_MAX_BYTES)
    return { ok: false, message: LOGO_MESSAGES.tooLarge };
  const type = sniffLogo(bytes);
  if (!type) return { ok: false, message: LOGO_MESSAGES.type };
  try {
    const out =
      type === 'image/png'
        ? rewritePng(bytes)
        : type === 'image/jpeg'
          ? rewriteJpeg(bytes)
          : sanitizeSvg(bytes);
    if (out.length > LOGO_MAX_BYTES)
      return { ok: false, message: LOGO_MESSAGES.tooLarge };
    return { ok: true, contentType: type, bytes: out };
  } catch (err) {
    if (err instanceof LogoError)
      return { ok: false, message: err.userMessage };
    return {
      ok: false,
      message:
        type === 'image/svg+xml' ? LOGO_MESSAGES.svg : LOGO_MESSAGES.damaged,
    };
  }
}

function damaged(): never {
  throw new LogoError(LOGO_MESSAGES.damaged);
}

function checkSide(width: number, height: number): void {
  if (width < 1 || height < 1) damaged();
  if (width > LOGO_MAX_SIDE || height > LOGO_MAX_SIDE)
    throw new LogoError(LOGO_MESSAGES.dimensions);
}

// ─── PNG ────────────────────────────────────────────────────────────────────

/** Trozos que se conservan: los de la imagen y los de color (sin texto ni EXIF). */
const PNG_KEEP = new Set([
  'IHDR',
  'PLTE',
  'tRNS',
  'IDAT',
  'IEND',
  'gAMA',
  'cHRM',
  'sRGB',
  'pHYs',
]);
const PNG_COLOR_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function rewritePng(bytes: Buffer): Buffer {
  const out: Buffer[] = [PNG_SIGNATURE];
  let offset = 8;
  let first = true;
  let idat = false;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || length > bytes.length - offset - 12)
      damaged();
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const crc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) >>> 0 !== crc)
      damaged();
    offset += 12 + length;

    if (first) {
      if (type !== 'IHDR' || length !== 13) damaged();
      checkSide(data.readUInt32BE(0), data.readUInt32BE(4));
      const depth = data[8];
      const color = data[9];
      if (
        !PNG_COLOR_DEPTHS[color]?.includes(depth) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] > 1
      ) {
        damaged();
      }
      first = false;
    } else if (type === 'IHDR') {
      damaged();
    }
    const critical = type[0] === type[0].toUpperCase();
    if (!PNG_KEEP.has(type)) {
      // Un trozo crítico desconocido no se puede saltar (la imagen no se
      // entendería sin él); uno auxiliar (texto, EXIF, perfil…) se cae.
      if (critical) damaged();
      continue;
    }
    if (type === 'IDAT') idat = true;
    out.push(pngChunk(type, data));
    if (type === 'IEND') {
      ended = true;
      break; // Lo que venga detrás del final no se copia.
    }
  }
  if (first || !idat || !ended) damaged();
  return Buffer.concat(out);
}

// ─── JPEG ───────────────────────────────────────────────────────────────────

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
/** Segmentos de imagen que se conservan (tablas, cuadro, barrido, reinicio). */
const JPEG_KEEP = new Set([0xdb, 0xc4, 0xcc, 0xdd, ...SOF_MARKERS]);

function rewriteJpeg(bytes: Buffer): Buffer {
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let offset = 2;
  let frame = false;
  let scan = false;
  for (;;) {
    if (offset >= bytes.length) damaged();
    if (bytes[offset] !== 0xff) damaged();
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1; // Relleno.
    if (offset >= bytes.length) damaged();
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) break; // EOI: lo que venga detrás no se copia.
    if (
      marker === 0xd8 ||
      marker === 0x00 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    )
      damaged();
    if (offset + 2 > bytes.length) damaged();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) damaged();
    const segment = bytes.subarray(offset - 2, offset + length);
    const body = bytes.subarray(offset + 2, offset + length);
    offset += length;

    if (SOF_MARKERS.has(marker)) {
      if (body.length < 6) damaged();
      checkSide(body.readUInt16BE(3), body.readUInt16BE(1));
      frame = true;
    }
    if (marker === 0xda) {
      if (!frame) damaged();
      // Datos del barrido: hasta el siguiente marcador que no sea relleno
      // (FF00) ni de reinicio (FFD0–FFD7).
      let end = offset;
      while (end + 1 < bytes.length) {
        if (bytes[end] === 0xff) {
          const next = bytes[end + 1];
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff)
            break;
        }
        end += 1;
      }
      if (end + 1 >= bytes.length) damaged();
      out.push(segment, bytes.subarray(offset, end));
      offset = end;
      scan = true;
      continue;
    }
    // APP0 (JFIF) y APP14 (Adobe, necesario para el color de algunos JPEG) se
    // quedan; el resto de APPn (EXIF con ubicación y cámara, XMP, ICC…) y los
    // comentarios se caen.
    if (marker === 0xe0 || marker === 0xee) {
      out.push(segment);
      continue;
    }
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) continue;
    if (!JPEG_KEEP.has(marker)) damaged();
    out.push(segment);
  }
  if (!frame || !scan) damaged();
  out.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(out);
}

// ─── SVG ────────────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Elementos de dibujo. Cualquier otro se cae CON todo su contenido. */
const SVG_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'symbol',
  'use',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'style',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
]);

const SVG_ATTRIBUTES = new Set([
  'id',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'fr',
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
  'version',
  'd',
  'points',
  'pathLength',
  'transform',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'color',
  'display',
  'visibility',
  'clip-path',
  'clip-rule',
  'mask',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'clipPathUnits',
  'maskUnits',
  'maskContentUnits',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'dx',
  'dy',
  'xml:space',
  'class',
  'style',
]);

/** `href` solo hacia un elemento del propio dibujo (`#id`). */
const LOCAL_REF = /^#[A-Za-z_][\w.-]*$/;
const URL_FUNCTION = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
const MAX_DEPTH = 64;
const MAX_ELEMENTS = 20000;

function svgFail(): never {
  throw new LogoError(LOGO_MESSAGES.svg);
}

/** Decodifica las cinco entidades XML y las numéricas; cualquier otra es un error. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);|&/gi,
    (_whole, ref: string | undefined) => {
      if (!ref) svgFail();
      const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
      };
      if (ref[0] !== '#') return named[ref] ?? svgFail();
      const code =
        ref[1] === 'x' || ref[1] === 'X'
          ? parseInt(ref.slice(2), 16)
          : parseInt(ref.slice(1), 10);
      if (
        !Number.isInteger(code) ||
        (code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd)
      )
        svgFail();
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) svgFail();
      return String.fromCodePoint(code);
    },
  );
}

const escapeText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

/**
 * CSS (atributo `style` o elemento `<style>`) que se puede conservar: sin
 * `@import` ni reglas `@`, sin escapes (con `\\` se disfraza un `url(`), sin
 * `<`, y `url()` solo hacia `#id`.
 */
function safeCss(css: string): boolean {
  return !/[@\\<]/.test(css) && safeValue('style', css);
}

/** Un valor de atributo que se puede conservar: `url()` solo hacia `#id`. */
function safeValue(name: string, value: string): boolean {
  if (/[\p{Cc}]/u.test(value.replace(/[\t\n\r]/g, ''))) return false;
  if (
    /(?:javascript|vbscript|data)\s*:/i.test(value) ||
    /expression\s*\(/i.test(value)
  )
    return false;
  if (name === 'style' && /[@\\<]/.test(value)) return false;
  const stripped = value.replace(
    URL_FUNCTION,
    (whole, _q: string, target: string) =>
      LOCAL_REF.test(target.trim()) ? '' : 'url(',
  );
  if (/url\s*\(/i.test(stripped)) return false;
  if (name === 'href' || name === 'xlink:href')
    return LOCAL_REF.test(value.trim());
  return true;
}

interface OpenElement {
  name: string;
  kept: boolean;
}

/**
 * Parser XML mínimo (solo lo que trae un SVG exportado): declaración XML,
 * comentarios, elementos, atributos entre comillas y texto. DOCTYPE,
 * entidades propias, CDATA e instrucciones de proceso se rechazan.
 */
function sanitizeSvg(bytes: Buffer): Buffer {
  const source = bytes.toString('utf8').replace(/^\uFEFF/, '');
  if (source.includes('\u0000') || source.includes('\uFFFD')) svgFail();
  const out: string[] = [];
  const stack: OpenElement[] = [];
  let i = 0;
  let rootSeen = false;
  let rootClosed = false;
  let elements = 0;

  const dropping = () => stack.some((e) => !e.kept);

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    const text = source.slice(i, lt === -1 ? source.length : lt);
    if (text.length > 0) {
      if (stack.length === 0) {
        if (text.trim() !== '') svgFail();
      } else if (!dropping()) {
        const decoded = decodeEntities(text);
        if (stack[stack.length - 1].name === 'style' && !safeCss(decoded))
          svgFail();
        out.push(escapeText(decoded));
      }
    }
    if (lt === -1) break;
    i = lt;

    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end === -1) svgFail();
      i = end + 3;
      continue;
    }
    if (source.startsWith('<?', i)) {
      // Solo la declaración XML, y al principio.
      if (
        out.length > 0 ||
        rootSeen ||
        !/^<\?xml[\s?]/.test(source.slice(i, i + 6))
      )
        svgFail();
      const end = source.indexOf('?>', i + 2);
      if (end === -1) svgFail();
      i = end + 2;
      continue;
    }
    if (source.startsWith('<![CDATA[', i) && stack.at(-1)?.name === 'style') {
      // CSS de un `<style>` envuelto en CDATA (así lo exportan algunos editores).
      const end = source.indexOf(']]>', i + 9);
      if (end === -1) svgFail();
      const css = source.slice(i + 9, end);
      if (!safeCss(css)) svgFail();
      if (!dropping()) out.push(escapeText(css));
      i = end + 3;
      continue;
    }
    if (source.startsWith('<!', i)) svgFail(); // DOCTYPE, ENTITY, otro CDATA.

    if (source.startsWith('</', i)) {
      const end = source.indexOf('>', i);
      if (end === -1) svgFail();
      const name = source.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) svgFail();
      if (open.kept && !dropping()) out.push(`</${name}>`);
      if (stack.length === 0) rootClosed = true;
      i = end + 1;
      continue;
    }

    // Etiqueta de apertura.
    let j = i + 1;
    const nameMatch = /^[A-Za-z_][\w.:-]*/.exec(source.slice(j, j + 256));
    if (!nameMatch) svgFail();
    const name = nameMatch[0];
    if (!NAME.test(name)) svgFail();
    j += name.length;
    const attrs: [string, string][] = [];
    let selfClosing = false;
    for (;;) {
      while (j < source.length && /\s/.test(source[j])) j += 1;
      if (j >= source.length) svgFail();
      if (source[j] === '>') {
        j += 1;
        break;
      }
      if (source.startsWith('/>', j)) {
        selfClosing = true;
        j += 2;
        break;
      }
      const attr = /^([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(
        source.slice(j, j + 1_000_000),
      );
      if (!attr || !NAME.test(attr[1])) svgFail();
      if (attrs.some(([n]) => n === attr[1])) svgFail();
      attrs.push([attr[1], decodeEntities(attr[3] ?? attr[4] ?? '')]);
      j += attr[0].length;
    }
    i = j;

    if (stack.length === 0) {
      if (rootSeen || name !== 'svg') svgFail();
      rootSeen = true;
    }
    if (rootClosed) svgFail();
    elements += 1;
    if (elements > MAX_ELEMENTS || stack.length >= MAX_DEPTH) svgFail();

    const kept = SVG_ELEMENTS.has(name) && !dropping();
    if (kept) {
      const parts: string[] = [name];
      if (stack.length === 0) {
        // xlink siempre declarado: un `<use xlink:href>` más abajo lo necesita.
        parts.push(`xmlns="${SVG_NS}"`, `xmlns:xlink="${XLINK_NS}"`);
      }
      for (const [attrName, value] of attrs) {
        if (attrName === 'xmlns' || attrName.startsWith('xmlns:')) continue;
        const isHref = attrName === 'href' || attrName === 'xlink:href';
        if (!SVG_ATTRIBUTES.has(attrName) && !isHref) continue;
        if (
          isHref &&
          !['use', 'linearGradient', 'radialGradient'].includes(name)
        )
          continue;
        if (!safeValue(attrName, value)) continue;
        parts.push(`${attrName}="${escapeAttr(value)}"`);
      }
      out.push(`<${parts.join(' ')}${selfClosing ? '/>' : '>'}`);
    }
    if (!selfClosing) stack.push({ name, kept });
    else if (stack.length === 0) rootClosed = true;
  }
  if (!rootSeen || !rootClosed || stack.length > 0) svgFail();
  return Buffer.from(out.join(''), 'utf8');
}
