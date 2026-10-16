import { inflateSync } from 'node:zlib';

/** Tope de cada firma: 200 KB del PNG ya decodificado. */
export const MAX_SIGNATURE_BYTES = 200 * 1024;

/** Longitud máxima en base64 de una firma de MAX_SIGNATURE_BYTES. */
export const MAX_SIGNATURE_BASE64_LENGTH =
  4 * Math.ceil(MAX_SIGNATURE_BYTES / 3);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_URL_PREFIX = /^data:([^;,]*);base64,/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** El mensaje va tal cual al 400: dice qué está mal sin repetir la imagen. */
export class SignatureImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureImageError';
  }
}

/**
 * Valida una firma y la devuelve como base64 PNG sin prefijo (lo que se
 * guarda y se sella con el hash). Acepta el `data:image/png;base64,...` que
 * produce `canvas.toDataURL()` o el base64 pelado.
 *
 * Comprueba de verdad el contenido, no la etiqueta: base64 bien formado,
 * firma PNG de 8 bytes seguida del chunk IHDR, y el tope de tamaño. Nunca
 * incluye la imagen en el error (no debe acabar en un log). `noun` nombra la
 * firma en el mensaje («la firma del paciente»).
 */
export function parseSignaturePng(input: string, noun = 'la firma'): string {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  let base64 = input.trim();
  const prefix = DATA_URL_PREFIX.exec(base64);
  if (prefix) {
    if (prefix[1].toLowerCase() !== 'image/png') {
      throw new SignatureImageError(`${Noun} debe ser una imagen PNG.`);
    }
    base64 = base64.slice(prefix[0].length);
  }
  if (base64 === '') {
    throw new SignatureImageError(`Falta ${noun}.`);
  }
  if (base64.length % 4 !== 0 || !BASE64.test(base64)) {
    throw new SignatureImageError(`${Noun} no es una imagen en base64 válida.`);
  }
  if (base64.length > MAX_SIGNATURE_BASE64_LENGTH) {
    throw new SignatureImageError(`${Noun} supera el tamaño máximo de 200 KB.`);
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_SIGNATURE_BYTES) {
    throw new SignatureImageError(`${Noun} supera el tamaño máximo de 200 KB.`);
  }
  const isPng =
    bytes.length >= 16 &&
    bytes.subarray(0, 8).equals(PNG_MAGIC) &&
    bytes.subarray(12, 16).toString('latin1') === 'IHDR';
  if (!isPng) {
    throw new SignatureImageError(`${Noun} debe ser una imagen PNG.`);
  }
  assertHasInk(bytes, Noun);
  return base64;
}

/** Alfa mínimo para contar un píxel como tinta (el lienzo vacío es 0). */
const MIN_INK_ALPHA = 16;
/** Muestras por píxel según el tipo de color PNG. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

/** IHDR + IDAT concatenados; para en IEND (lo que siga se ignora). */
function readChunks(bytes: Buffer): { header: PngHeader; data: Buffer } {
  const idat: Buffer[] = [];
  let header: PngHeader | null = null;
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) throw new Error('chunk truncado');
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!header || idat.length === 0) throw new Error('sin IHDR o IDAT');
  return { header, data: Buffer.concat(idat) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Deshace los filtros de cada fila (PNG sin entrelazar); devuelve las filas. */
function unfilter(raw: Buffer, header: PngHeader): Buffer[] {
  const channels = CHANNELS[header.colorType];
  if (channels === undefined) throw new Error('tipo de color');
  const bitsPerPixel = channels * header.bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((header.width * bitsPerPixel) / 8);
  if (raw.length < header.height * (stride + 1))
    throw new Error('datos cortos');
  const rows: Buffer[] = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    const row = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = previous[i];
      const upLeft = i >= bpp ? previous[i - bpp] : 0;
      const add =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? (left + up) >> 1
                : filter === 4
                  ? paeth(left, up, upLeft)
                  : -1;
      if (add < 0) throw new Error('filtro');
      row[i] = (row[i] + add) & 0xff;
    }
    rows.push(row);
    previous = row;
  }
  return rows;
}

/**
 * ¿Hay algo dibujado? Con canal alfa (lo que exporta el lienzo): algún píxel
 * con alfa ≥ MIN_INK_ALPHA. Sin alfa: la imagen no es de un solo color. Así
 * se rechaza el PNG transparente de un lienzo sin trazos (DX-012).
 */
function hasInk(rows: Buffer[], header: PngHeader): boolean {
  const { colorType, bitDepth, width } = header;
  if (colorType === 4 || colorType === 6) {
    const sampleBytes = bitDepth / 8;
    const pixelBytes = CHANNELS[colorType] * sampleBytes;
    // Byte más significativo del alfa (último canal).
    const alphaAt = pixelBytes - sampleBytes;
    return rows.some((row) => {
      for (let x = 0; x < width; x++) {
        if (row[x * pixelBytes + alphaAt] >= MIN_INK_ALPHA) return true;
      }
      return false;
    });
  }
  // Sin alfa: se comparan los bytes de imagen (sin el último de cada fila,
  // que con profundidades < 8 bits puede llevar relleno).
  const first = rows[0][0];
  return rows.some((row) => {
    for (let i = 0; i < Math.max(1, row.length - 1); i++) {
      if (row[i] !== first) return true;
    }
    return bitDepth >= 8 && row[row.length - 1] !== first;
  });
}

function assertHasInk(bytes: Buffer, Noun: string): void {
  let header: PngHeader;
  let rows: Buffer[];
  try {
    const chunks = readChunks(bytes);
    header = chunks.header;
    if (header.interlace !== 0) {
      throw new SignatureImageError(`${Noun} debe ser un PNG sin entrelazar.`);
    }
    rows = unfilter(inflateSync(chunks.data), header);
  } catch (error) {
    if (error instanceof SignatureImageError) throw error;
    throw new SignatureImageError(`${Noun} no es una imagen PNG válida.`);
  }
  if (!hasInk(rows, header)) {
    throw new SignatureImageError(
      `${Noun} está en blanco: firma en el recuadro.`,
    );
  }
}
