import { crc32 } from 'node:zlib';

/**
 * DX-019: el logo de la clínica (PNG, JPEG o WebP, hasta 1 MB). Es PÚBLICO por
 * diseño (login, documentos, páginas del paciente), así que nunca se guarda lo
 * que manda el navegador tal cual (SEC-012):
 *
 * - El tipo sale de los BYTES (magic bytes), nunca de la etiqueta del multipart
 *   ni de la extensión del nombre. SVG NO se admite: es un documento activo.
 * - Se RE-ESCRIBE desde lo que se validó: cada formato solo con sus trozos de
 *   imagen; se cae lo demás (metadatos, EXIF con la ubicación, comentarios, y
 *   lo pegado tras el final de la imagen, que es como se arma un «políglota»).
 *
 * Es una re-escritura del contenedor, no una re-codificación de píxeles (la
 * API no lleva una librería de imagen). Puro y sin dependencias; un fallo es
 * un 400 con el mensaje en español.
 */

export const LOGO_MAX_BYTES = 1024 * 1024;
/** Lado máximo de un PNG o JPEG: más es un logo absurdo (o una bomba de descompresión). */
export const LOGO_MAX_SIDE = 8192;

export type LogoContentType = 'image/png' | 'image/jpeg' | 'image/webp';

export const LOGO_EXTENSION: Record<LogoContentType, 'png' | 'jpg' | 'webp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export const LOGO_MESSAGES = {
  empty: 'El logo está vacío.',
  tooLarge: 'El logo supera el máximo de 1 MB.',
  type: 'El logo debe ser una imagen PNG, JPG o WebP.',
  damaged:
    'El logo no es una imagen válida o está dañado. Expórtalo de nuevo y vuelve a subirlo.',
  dimensions: `El logo es demasiado grande: como mucho ${LOGO_MAX_SIDE} × ${LOGO_MAX_SIDE} píxeles.`,
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

/** Tipo por los bytes: PNG, JPEG o WebP; cualquier otra cosa (SVG incluido), `null`. */
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
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
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
          : rewriteWebp(bytes);
    if (out.length > LOGO_MAX_BYTES)
      return { ok: false, message: LOGO_MESSAGES.tooLarge };
    return { ok: true, contentType: type, bytes: out };
  } catch (err) {
    if (err instanceof LogoError)
      return { ok: false, message: err.userMessage };
    return { ok: false, message: LOGO_MESSAGES.damaged };
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

// ─── WebP ───────────────────────────────────────────────────────────────────

/** Trozos de imagen; EXIF, XMP e ICCP se caen. */
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);
/** Bits de VP8X que anuncian ICC, EXIF y XMP (se quitan: esos trozos se caen). */
const VP8X_METADATA_FLAGS = 0x20 | 0x08 | 0x04;

function rewriteWebp(bytes: Buffer): Buffer {
  const declared = bytes.readUInt32LE(4);
  const end = declared + 8;
  if (declared < 4 || end > bytes.length) damaged();
  const out: Buffer[] = [];
  let offset = 12;
  let image = false;
  while (offset < end) {
    if (offset + 8 > end) damaged();
    const type = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const padded = size + (size % 2);
    if (offset + 8 + padded > end) damaged();
    const data = Buffer.from(bytes.subarray(offset + 8, offset + 8 + size));
    offset += 8 + padded;
    if (!/^[\x20-\x7e]{4}$/.test(type)) damaged();
    if (!WEBP_KEEP.has(type)) continue;
    if (type === 'VP8X') {
      if (size !== 10) damaged();
      data[0] &= ~VP8X_METADATA_FLAGS;
      checkSide(data.readUIntLE(4, 3) + 1, data.readUIntLE(7, 3) + 1);
    }
    if (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') image = true;
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32LE(size, 4);
    out.push(head, data, Buffer.alloc(size % 2));
  }
  if (!image) damaged();
  const body = Buffer.concat(out);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write('WEBP', 8, 'latin1');
  return Buffer.concat([riff, body]); // Lo que venga tras el RIFF no se copia.
}
