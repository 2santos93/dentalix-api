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
  return base64;
}
