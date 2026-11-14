import type { LogoImageCodec } from './ports/logo-image-codec.port';

/**
 * DX-019: el logo de la clínica (PNG, JPEG o WebP, hasta 1 MB). Es PÚBLICO por
 * diseño (login, documentos, páginas del paciente), así que nunca se guarda lo
 * que manda el navegador tal cual (SEC-012):
 *
 * - El tipo sale de los BYTES (magic bytes), nunca de la etiqueta del multipart
 *   ni de la extensión del nombre. SVG NO se admite: es un documento activo.
 *   Esta lista blanca va ANTES de la librería de imagen: SVG, GIF, TIFF… nunca
 *   llegan a decodificarse.
 * - DX-019-bis: se RE-CODIFICA desde los píxeles (`LogoImageCodec`): lo que no
 *   decodifica se rechaza; sale sin metadatos (EXIF con la ubicación,
 *   comentarios, perfiles), sin lo pegado tras el final (un «políglota»), sin
 *   animación (primer fotograma), con la orientación ya aplicada, en sRGB y
 *   con ≤ 1024 px de lado.
 *
 * Un fallo es un 400 con el mensaje en español (nunca el de la librería).
 */

export const LOGO_MAX_BYTES = 1024 * 1024;
/** Lado máximo de la ENTRADA: más es un logo absurdo (o una bomba de descompresión). */
export const LOGO_MAX_SIDE = 4096;
/**
 * Píxeles máximos de la entrada (4096 × 4096 ≈ 16,7 Mpx): acota la memoria de
 * cada decodificación (hay hasta 4 subidas a la vez por réplica).
 */
export const LOGO_MAX_PIXELS = LOGO_MAX_SIDE * LOGO_MAX_SIDE;
/** Lado máximo de la SALIDA: se pinta a ≤ 160 px y sobra para imprimir. */
export const LOGO_OUTPUT_MAX_SIDE = 1024;

/** Tipos que se aceptan (por sus bytes). */
export type LogoContentType = 'image/png' | 'image/jpeg' | 'image/webp';
/** Tipos que se guardan: WebP sale PNG (emails de Outlook y PDF de servidor no lo leen). */
export type LogoOutputType = 'image/png' | 'image/jpeg';

/** D2: PNG → PNG, JPEG → JPEG, WebP → PNG (conserva la transparencia). */
export const LOGO_OUTPUT_TYPE: Record<LogoContentType, LogoOutputType> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/png',
};

export const LOGO_EXTENSION: Record<LogoOutputType, 'png' | 'jpg'> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

export const LOGO_MESSAGES = {
  empty: 'El logo está vacío.',
  tooLarge: 'El logo supera el máximo de 1 MB.',
  type: 'El logo debe ser una imagen PNG, JPG o WebP.',
  damaged:
    'El logo no es una imagen válida o está dañado. Expórtalo de nuevo y vuelve a subirlo.',
  dimensions: `El logo es demasiado grande: como mucho ${LOGO_MAX_SIDE} × ${LOGO_MAX_SIDE} píxeles.`,
  // La re-codificación (PNG sin pérdida) puede pesar más que el original: una
  // foto como logo. El mensaje dice qué hacer en vez de culpar al fichero subido.
  tooHeavyAfterEncode:
    'El logo pesa más de 1 MB una vez procesado. Usa una imagen más sencilla (pocos colores) o más pequeña.',
} as const;

export type SanitizedLogo =
  | { ok: true; contentType: LogoOutputType; bytes: Buffer }
  | { ok: false; message: string };

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

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

/**
 * Valida y re-codifica el logo. Nunca lanza: `{ ok: false, message }`. Vacío,
 * de más de 1 MB o de un tipo no admitido se rechaza sin tocar el codec.
 */
export async function sanitizeLogo(
  bytes: Buffer,
  codec: LogoImageCodec,
): Promise<SanitizedLogo> {
  if (bytes.length === 0) return { ok: false, message: LOGO_MESSAGES.empty };
  if (bytes.length > LOGO_MAX_BYTES)
    return { ok: false, message: LOGO_MESSAGES.tooLarge };
  const type = sniffLogo(bytes);
  if (!type) return { ok: false, message: LOGO_MESSAGES.type };
  const output = LOGO_OUTPUT_TYPE[type];
  try {
    const result = await codec.reencode(bytes, { input: type, output });
    if (!result.ok) return { ok: false, message: LOGO_MESSAGES[result.reason] };
    if (result.bytes.length > LOGO_MAX_BYTES)
      return { ok: false, message: LOGO_MESSAGES.tooHeavyAfterEncode };
    return { ok: true, contentType: output, bytes: result.bytes };
  } catch {
    return { ok: false, message: LOGO_MESSAGES.damaged };
  }
}
