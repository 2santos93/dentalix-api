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
/** Profundidades de bits que admite cada tipo de color (PNG 11.2.2). */
const BIT_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

/**
 * Dimensiones máximas de una firma (SEC-026). El lienzo de la web mide 160 px
 * CSS de alto a como mucho 2x (`MAX_PIXEL_RATIO`), o sea 320 px, y de ancho el
 * del modal (≤ ~1200 px CSS → 2400): hay margen de sobra, también para un
 * móvil a 3x. Se comprueban ANTES de inflar: con ellas, lo que puede costar
 * descomprimir una firma queda acotado (≤ 4 M píxeles, ~16 MB en RGBA de 8
 * bits) por mucho que el IDAT diga otra cosa.
 */
export const MAX_SIGNATURE_WIDTH = 4096;
export const MAX_SIGNATURE_HEIGHT = 1024;
export const MAX_SIGNATURE_PIXELS = 4_000_000;
/**
 * Presupuesto de trabajo por firma, además de las dimensiones: lo que infla
 * (≤ el de un RGBA de 8 bits de MAX_SIGNATURE_PIXELS, ~16 MB) y los bytes
 * cuyo filtro hay que deshacer para buscar tinta (≤ MAX_SIGNATURE_PIXELS:
 * con alfa es un byte por píxel; sin alfa, todos). El lienzo exporta RGBA de
 * 8 bits y no se acerca; lo que lo supera son PNG de 16 bits o sin alfa muy
 * grandes, que costarían varias veces más CPU por la misma área.
 */
const MAX_SIGNATURE_RAW_BYTES = MAX_SIGNATURE_PIXELS * 4 + MAX_SIGNATURE_HEIGHT;
const MAX_SIGNATURE_SCAN_BYTES = MAX_SIGNATURE_PIXELS;

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

/** El IHDR va justo tras la firma PNG (ya comprobado su tipo en offset 12). */
function readHeader(bytes: Buffer): PngHeader {
  if (bytes.length < 8 + 8 + 13 || bytes.readUInt32BE(8) !== 13) {
    throw new Error('IHDR');
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    interlace: bytes[28],
  };
}

/** IDAT concatenados; para en IEND (lo que siga se ignora). */
function readImageData(bytes: Buffer): Buffer {
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) throw new Error('chunk truncado');
    if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (idat.length === 0) throw new Error('sin IDAT');
  return Buffer.concat(idat);
}

/**
 * Cómo se recorre la imagen: bytes por fila (sin el de filtro), bytes por
 * píxel para el filtro y qué bytes de cada fila hacen falta para saber si hay
 * tinta. Los filtros PNG trabajan byte a byte contra el MISMO byte del píxel
 * de la izquierda y de la fila de arriba, así que cada posición dentro del
 * píxel es un flujo independiente: con canal alfa (lo que exporta el lienzo)
 * basta deshacer el byte más significativo del alfa (`from`, de `step` en
 * `step`), una cuarta parte del trabajo en RGBA. Sin alfa, todos los bytes.
 */
interface Layout {
  stride: number;
  bpp: number;
  from: number;
  step: number;
  hasAlpha: boolean;
}

function layout(header: PngHeader): Layout {
  const { colorType, bitDepth, width } = header;
  const bitsPerPixel = CHANNELS[colorType] * bitDepth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  if (colorType === 4 || colorType === 6) {
    // Con alfa la profundidad es 8 o 16: el píxel ocupa bytes enteros.
    return { stride, bpp, from: bpp - bitDepth / 8, step: bpp, hasAlpha: true };
  }
  return { stride, bpp, from: 0, step: 1, hasAlpha: false };
}

/**
 * Deshace EN SITIO el filtro de los bytes `from`, `from + step`… de la fila
 * que empieza en `row`, con la fila previa ya deshecha en `up` (-1 si es la
 * primera, cuyo «arriba» es 0). No copia filas: lo único en memoria es la
 * salida de inflate, ya acotada.
 */
function unfilterRow(
  raw: Buffer,
  filter: number,
  row: number,
  up: number,
  { stride, bpp, from, step }: Layout,
): void {
  if (filter === 0) return;
  if (filter > 4) throw new Error('filtro');
  // Un bucle por filtro, sin decidir el filtro en cada byte: el peor caso
  // dentro de los límites es una imagen de 4 M píxeles toda en Paeth. Los
  // bytes del primer píxel (i < bpp) no tienen «izquierda» (cuenta como 0).
  if (up < 0) {
    // Primera fila: «arriba» es 0. Up no cambia nada, Average suma la mitad
    // de la izquierda y Paeth se queda con la izquierda (igual que Sub).
    if (filter === 2) return;
    for (
      let i = from + step * Math.ceil((bpp - from) / step);
      i < stride;
      i += step
    ) {
      const a = raw[row + i - bpp];
      raw[row + i] = (raw[row + i] + (filter === 3 ? a >> 1 : a)) & 0xff;
    }
    return;
  }
  // Primer píxel: sin izquierda ni arriba-izquierda, Up/Paeth predicen
  // «arriba», Average la mitad de «arriba» y Sub nada.
  let i = from;
  for (; i < bpp && i < stride; i += step) {
    const b = raw[up + i];
    const predictor = filter === 1 ? 0 : filter === 3 ? b >> 1 : b;
    raw[row + i] = (raw[row + i] + predictor) & 0xff;
  }
  const first = i;
  if (filter === 1) {
    for (i = first; i < stride; i += step) {
      raw[row + i] = (raw[row + i] + raw[row + i - bpp]) & 0xff;
    }
  } else if (filter === 2) {
    for (i = first; i < stride; i += step) {
      raw[row + i] = (raw[row + i] + raw[up + i]) & 0xff;
    }
  } else if (filter === 3) {
    for (i = first; i < stride; i += step) {
      raw[row + i] =
        (raw[row + i] + ((raw[row + i - bpp] + raw[up + i]) >> 1)) & 0xff;
    }
  } else {
    for (i = first; i < stride; i += step) {
      const a = raw[row + i - bpp];
      const b = raw[up + i];
      const c = raw[up + i - bpp];
      const pa = b > c ? b - c : c - b;
      const pb = a > c ? a - c : c - a;
      const p = a + b - c - c;
      const pc = p < 0 ? -p : p;
      const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[row + i] = (raw[row + i] + predictor) & 0xff;
    }
  }
}

/**
 * ¿Hay algo dibujado en esta fila (ya sin filtro)? Con canal alfa: algún
 * píxel con alfa ≥ MIN_INK_ALPHA. Sin alfa: algún byte distinto de `first`
 * (el primero de la imagen), sin contar el último de la fila, que con
 * profundidades < 8 bits puede llevar relleno.
 */
function rowHasInk(
  raw: Buffer,
  row: number,
  { stride, from, step, hasAlpha }: Layout,
  bitDepth: number,
  first: number,
): boolean {
  if (hasAlpha) {
    for (let i = from; i < stride; i += step) {
      if (raw[row + i] >= MIN_INK_ALPHA) return true;
    }
    return false;
  }
  for (let i = 0; i < Math.max(1, stride - 1); i++) {
    if (raw[row + i] !== first) return true;
  }
  return bitDepth >= 8 && raw[row + stride - 1] !== first;
}

/**
 * Infla con tope de salida (lo que la cabecera dice que ocupan las filas) y
 * recorre las filas una a una: deshace el filtro con la fila previa y mira si
 * hay tinta. Al encontrarla deja de deshacer filtros, pero sigue comprobando
 * el byte de filtro del resto para rechazar un PNG roto más abajo. Así se
 * rechaza el PNG transparente de un lienzo sin trazos (DX-012) sin abrir la
 * puerta a una bomba de descompresión (SEC-026).
 */
function scanForInk(data: Buffer, header: PngHeader, shape: Layout): boolean {
  const rowBytes = shape.stride + 1;
  const expected = header.height * rowBytes;
  // Si el IDAT infla más que esto, inflateSync lanza (RangeError) en cuanto
  // lo supera, sin llegar a reservar el resto.
  const raw = inflateSync(data, { maxOutputLength: expected });
  if (raw.length < expected) throw new Error('datos cortos');
  let ink = false;
  let first = 0;
  for (let y = 0; y < header.height; y++) {
    const start = y * rowBytes;
    const filter = raw[start];
    if (ink) {
      // Ya hay tinta: deshacer el resto no aporta nada, pero un filtro
      // inexistente sigue haciendo inválido el PNG.
      if (filter > 4) throw new Error('filtro');
      continue;
    }
    const up = y === 0 ? -1 : start - rowBytes + 1;
    unfilterRow(raw, filter, start + 1, up, shape);
    if (y === 0) first = raw[1];
    ink = rowHasInk(raw, start + 1, shape, header.bitDepth, first);
  }
  return ink;
}

function assertHasInk(bytes: Buffer, Noun: string): void {
  let ink: boolean;
  try {
    const header = readHeader(bytes);
    const { width, height, colorType, bitDepth } = header;
    if (
      width < 1 ||
      height < 1 ||
      width > MAX_SIGNATURE_WIDTH ||
      height > MAX_SIGNATURE_HEIGHT ||
      width * height > MAX_SIGNATURE_PIXELS
    ) {
      throw new SignatureImageError(
        `${Noun} tiene unas dimensiones no válidas (máximo ${MAX_SIGNATURE_WIDTH} x ${MAX_SIGNATURE_HEIGHT} píxeles).`,
      );
    }
    if (!BIT_DEPTHS[colorType]?.includes(bitDepth)) {
      throw new Error('tipo de color o profundidad');
    }
    if (header.interlace !== 0) {
      throw new SignatureImageError(`${Noun} debe ser un PNG sin entrelazar.`);
    }
    const shape = layout(header);
    const scanBytes = shape.hasAlpha ? width * height : shape.stride * height;
    if (
      height * (shape.stride + 1) > MAX_SIGNATURE_RAW_BYTES ||
      scanBytes > MAX_SIGNATURE_SCAN_BYTES
    ) {
      throw new SignatureImageError(
        `${Noun} es una imagen demasiado pesada: usa un PNG de 8 bits con transparencia.`,
      );
    }
    ink = scanForInk(readImageData(bytes), header, shape);
  } catch (error) {
    if (error instanceof SignatureImageError) throw error;
    throw new SignatureImageError(`${Noun} no es una imagen PNG válida.`);
  }
  if (!ink) {
    throw new SignatureImageError(
      `${Noun} está en blanco: firma en el recuadro.`,
    );
  }
}
