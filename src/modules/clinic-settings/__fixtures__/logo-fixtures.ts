import { deflateSync, crc32 } from 'node:zlib';
import sharp from 'sharp';

/**
 * DX-019: imágenes mínimas de prueba para el logo (generadas, sin datos
 * reales). DX-019-bis: todas DECODIFICAN de verdad (la API re-codifica con
 * libvips), salvo las que se rompen a propósito en cada prueba.
 */

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** PNG RGB de `width` × `height` en un color, con trozos extra opcionales (p. ej. tEXt). */
export function makePng(
  width = 4,
  height = 4,
  extra: { before?: Buffer[]; after?: Buffer } = {},
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(extra.before ?? []),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
    ...(extra.after ? [extra.after] : []),
  ]);
}

export const pngChunk = chunk;

/** JPEG 4×4 exportado con JFIF y un bloque EXIF (APP1). */
export const JPEG_WITH_EXIF = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAABAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgABAAEAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+Y6KKK/fD+Kz/9k=',
  'base64',
);

/**
 * WebP real (sin pérdida) de `width` × `height` en un color, con alfa. Con
 * `exif`, lleva un bloque EXIF de verdad (contenedor VP8X), como el que deja
 * una cámara o un editor.
 */
export function makeWebp(
  width = 4,
  height = 4,
  opts: { exif?: string; alpha?: number } = {},
): Promise<Buffer> {
  const img = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0x0e, g: 0x74, b: 0x90, alpha: opts.alpha ?? 1 },
    },
  }).webp({ lossless: true });
  return (
    opts.exif ? img.withExif({ IFD0: { Copyright: opts.exif } }) : img
  ).toBuffer();
}

/**
 * APNG de dos fotogramas: la imagen por defecto (IDAT) en rojo y un segundo
 * fotograma (fdAT) en azul. Quien no entiende APNG ve solo el primero.
 */
export function makeApng(width = 4, height = 4): Buffer {
  const frame = (rgb: [number, number, number]) => {
    const row = Buffer.concat([
      Buffer.from([0]),
      Buffer.concat(Array.from({ length: width }, () => Buffer.from(rgb))),
    ]);
    return deflateSync(
      Buffer.concat(Array.from({ length: height }, () => row)),
    );
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2, 0);
  const fctl = (seq: number) => {
    const b = Buffer.alloc(26);
    b.writeUInt32BE(seq, 0);
    b.writeUInt32BE(width, 4);
    b.writeUInt32BE(height, 8);
    b.writeUInt16BE(1, 20);
    b.writeUInt16BE(1, 22);
    return b;
  };
  const fdatSeq = Buffer.alloc(4);
  fdatSeq.writeUInt32BE(2, 0);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('acTL', actl),
    chunk('fcTL', fctl(0)),
    chunk('IDAT', frame([0xff, 0, 0])),
    chunk('fcTL', fctl(1)),
    chunk('fdAT', Buffer.concat([fdatSeq, frame([0, 0, 0xff])])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PNG cuya cabecera dice `width` × `height` (CRC correcto) con un IDAT mínimo: una «bomba». */
export function makePngHeader(width: number, height: number): Buffer {
  const png = makePng(1, 1);
  const ihdr = Buffer.from(png.subarray(16, 29));
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([
    png.subarray(0, 8),
    chunk('IHDR', ihdr),
    png.subarray(33),
  ]);
}

export const SVG_WITH_SCRIPT = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><rect width="1" height="1"/></svg>',
  'utf8',
);
