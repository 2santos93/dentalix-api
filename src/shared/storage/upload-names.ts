/**
 * Nombres y huellas de los ficheros subidos (documentos del paciente, DX-151,
 * y soportes de gastos, DX-274). Puro: sin Nest ni Prisma.
 */
export const MAX_ORIGINAL_NAME_LENGTH = 255;
export const FALLBACK_ORIGINAL_NAME = 'documento';

/**
 * Controles (Cc), caracteres de formato (Cf: marcas y overrides bidi, ancho
 * cero, U+061C, U+2060-2064, BOM, …) y separadores de línea y párrafo
 * (U+2028/U+2029): `foto<U+202E>gnp.exe` se ve como «fotoexe.png».
 */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const EXTENSION = /\.[^.]{1,16}$/;

/**
 * Nombre original SOLO para mostrar (la clave del almacén no lo usa): sin
 * controles, sin componentes de ruta (`/` ni `\`), recortado y con como mucho
 * 255 caracteres (puntos de código) conservando la extensión. Si no queda
 * nada útil, «documento».
 */
export function normalizeOriginalName(name: string): string {
  const clean = name.replace(UNSAFE_CHARS, '');
  const base = (clean.split(/[/\\]/).pop() ?? '').trim();
  if (base === '' || /^\.+$/.test(base)) return FALLBACK_ORIGINAL_NAME;

  const chars = Array.from(base);
  if (chars.length <= MAX_ORIGINAL_NAME_LENGTH) return base;
  const ext = EXTENSION.exec(base)?.[0] ?? '';
  const keep = MAX_ORIGINAL_NAME_LENGTH - Array.from(ext).length;
  return chars.slice(0, keep).join('') + ext;
}

/** ¿64 dígitos hex (en cualquier caja)? */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value.trim());
}

/** La misma huella en base64, como la guarda S3 (`x-amz-checksum-sha256`). */
export function sha256HexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}
