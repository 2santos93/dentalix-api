import { crc32, deflateSync } from 'node:zlib';

/**
 * PNG sintéticos para probar la validación de firmas (SEC-026): firmas de
 * tamaño real y «bombas» de descompresión (un PNG pequeño cuyo IDAT infla a
 * cientos de MB).
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typeBytes = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, body])) >>> 0);
  return Buffer.concat([len, typeBytes, body, crc]);
}

/**
 * PNG con la cabecera que se diga y `raw` (filas ya filtradas, con su byte de
 * filtro) comprimido tal cual: la cabecera puede mentir sobre los datos.
 */
export function pngFromRaw(
  width: number,
  height: number,
  raw: Buffer,
  {
    colorType = 6,
    bitDepth = 8,
  }: { colorType?: number; bitDepth?: number } = {},
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  return Buffer.concat([
    PNG_MAGIC,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Firma RGBA de `width` x `height` como la exporta el lienzo: fondo
 * transparente y un trazo horizontal en la fila `inkRow` (por defecto, la del
 * medio). Filas con filtro «Up» (2) para que el decodificador lo deshaga.
 */
export function signaturePng(
  width: number,
  height: number,
  inkRow = Math.floor(height / 2),
): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 2; // Up: la diferencia con la fila de arriba.
  }
  // Con «Up», el trazo aparece en `inkRow` y desaparece en la siguiente.
  const put = (y: number, alpha: number) => {
    if (y >= height) return;
    const start = y * (stride + 1) + 1;
    for (
      let x = Math.floor(width / 10);
      x < Math.floor((width * 9) / 10);
      x++
    ) {
      raw[start + x * 4] = 17;
      raw[start + x * 4 + 1] = 24;
      raw[start + x * 4 + 2] = 39;
      raw[start + x * 4 + 3] = alpha;
    }
  };
  put(inkRow, 255);
  // Fila siguiente: restar el trazo (256 - v) la deja transparente.
  if (inkRow + 1 < height) {
    const start = (inkRow + 1) * (stride + 1) + 1;
    for (
      let x = Math.floor(width / 10);
      x < Math.floor((width * 9) / 10);
      x++
    ) {
      raw[start + x * 4] = 256 - 17;
      raw[start + x * 4 + 1] = 256 - 24;
      raw[start + x * 4 + 2] = 256 - 39;
      raw[start + x * 4 + 3] = 1; // 255 + 1 = 0 (mod 256)
    }
  }
  return pngFromRaw(width, height, raw);
}

let bombCache: string | null = null;
let lyingBombCache: string | null = null;

/**
 * Bomba de descompresión del auditor (SEC-026): ~194 KB de PNG (cabe bajo el
 * tope de 200 KB) con IHDR de 10000 x 5000 RGBA cuyo IDAT infla a 200 MB de
 * ceros, con un píxel de tinta en la última fila para que pase el control de
 * «en blanco». Antes del fix costaba ~2,4 s de CPU síncrona y ~400 MB.
 */
export function pngBombBase64(): string {
  if (bombCache) return bombCache;
  const width = 10000;
  const height = 5000;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  raw[(height - 1) * (stride + 1) + 1 + 3] = 255;
  bombCache = pngFromRaw(width, height, raw).toString('base64');
  return bombCache;
}

/**
 * Bomba con cabecera dentro de los límites (100 x 100 RGBA = 40 KB de filas)
 * pero un IDAT que infla a 100 MB: solo la para el tope de salida de inflate.
 */
export function pngLyingBombBase64(): string {
  if (lyingBombCache) return lyingBombCache;
  const raw = Buffer.alloc(100 * 1024 * 1024);
  raw[1 + 3] = 255; // tinta en el primer píxel
  lyingBombCache = pngFromRaw(100, 100, raw).toString('base64');
  return lyingBombCache;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Codificador PNG de referencia: `pixels` son las filas SIN filtrar (sin byte
 * de filtro, `bpp` bytes por píxel) y la fila `y` se filtra con el filtro
 * `y % 5` (None, Sub, Up, Average, Paeth), para comprobar que el
 * decodificador deshace los cinco.
 */
export function pngAllFilters(
  width: number,
  height: number,
  pixels: Buffer,
  {
    colorType = 6,
    bitDepth = 8,
  }: { colorType?: number; bitDepth?: number } = {},
): Buffer {
  const bpp = Math.max(1, (pixels.length / (width * height)) | 0);
  const stride = width * bpp;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const x = pixels[y * stride + i];
      const a = i >= bpp ? pixels[y * stride + i - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= bpp ? pixels[(y - 1) * stride + i - bpp] : 0;
      const predictor = [0, a, b, (a + b) >> 1, paethPredictor(a, b, c)][
        filter
      ];
      raw[y * (stride + 1) + 1 + i] = (x - predictor + 256) & 0xff;
    }
  }
  return pngFromRaw(width, height, raw, { colorType, bitDepth });
}

/** Bytes pseudoaleatorios reproducibles (semilla fija). */
export function noise(length: number, seed = 1): Buffer {
  const out = Buffer.alloc(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}
