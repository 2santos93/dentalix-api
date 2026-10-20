import { isServableContentType } from './content-type';

export const FILE_STORAGE = Symbol('FILE_STORAGE');

/**
 * Cómo debe responder una URL firmada (DX-151): `inline` para verlo en el
 * navegador (visor de PDF/imagen) o `attachment` para descargarlo, con el
 * nombre original del documento y, si hace falta, el tipo que se anuncia.
 */
export interface SignedUrlOptions {
  disposition: 'inline' | 'attachment';
  /** Nombre que verá el usuario; se sanea en `contentDispositionHeader`. */
  filename?: string;
  /**
   * `Content-Type` de la respuesta; sin él, el guardado (S3) o la extensión
   * (disco). Solo uno de la lista blanca de `content-type.ts`: con otro,
   * `getSignedUrl` rechaza.
   */
  contentType?: string;
}

/** Contenido leído de un fichero guardado. */
export interface StoredFile {
  bytes: Buffer;
  contentType: string | null;
}

/**
 * Almacén de ficheros (DX-084). Trabaja con CLAVES (`avatars/u1.png`, ver
 * `file-key.ts`); lo que se guarda en la BD es la clave, nunca una URL.
 * Adaptadores: `DiskFileStorage` (solo fuera de producción) y
 * `S3FileStorage` (S3, R2 o MinIO), según `STORAGE_DRIVER`.
 */
export interface FileStoragePort {
  /** Persiste `bytes` bajo `key` (reemplaza si ya existe). */
  save(key: string, bytes: Buffer, contentType: string): Promise<void>;

  /** Lee `key`, o null si no existe. */
  read(key: string): Promise<StoredFile | null>;

  /** Borra `key`. Idempotente: no falla si no existe. */
  delete(key: string): Promise<void>;

  /**
   * URL estable para lo PÚBLICO (avatares, logos): la API lo sirve en
   * `FILES_PUBLIC_BASE_URL/<key>` leyendo del almacén, así que vale igual con
   * cualquier réplica y el bucket sigue siendo privado. Nada clínico por aquí.
   */
  publicUrl(key: string): string;

  /**
   * URL temporal para lo PRIVADO (radiografías, PDFs — DX-008): caduca a los
   * `ttlSeconds` (1 s – 7 días, el máximo de S3 con SigV4). Con `options`
   * la respuesta lleva esa disposición, nombre y tipo, y van firmados: no se
   * pueden cambiar en la URL sin invalidarla (DX-151). Rechaza un
   * `contentType` fuera de la lista blanca (`assertSignedUrlOptions`).
   */
  getSignedUrl(
    key: string,
    ttlSeconds: number,
    options?: SignedUrlOptions,
  ): Promise<string>;
}

/** Máximo de una URL firmada con SigV4 (7 días). */
export const SIGNED_URL_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

export function assertSignedUrlTtl(ttlSeconds: number): void {
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > SIGNED_URL_MAX_TTL_SECONDS
  ) {
    throw new Error(
      `TTL de URL firmada inválido: debe ser un entero entre 1 y ${SIGNED_URL_MAX_TTL_SECONDS} segundos.`,
    );
  }
}

/** Las opciones de URL firmada que un adaptador acepta firmar (DX-151). */
export function assertSignedUrlOptions(options?: SignedUrlOptions): void {
  if (options?.contentType && !isServableContentType(options.contentType)) {
    throw new Error(
      `Tipo de URL firmada no permitido: "${options.contentType}" no está en la lista blanca.`,
    );
  }
}

/** Longitud máxima del nombre en la cabecera (la de un nombre de fichero). */
const MAX_FILENAME_LENGTH = 255;

/**
 * Recorta a `max` caracteres (code points) conservando la extensión si es
 * corta (≤ 16); si no, corta sin más.
 */
function capLength(name: string, max: number): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? Array.from(name.slice(dot)) : [];
  if (ext.length === 0 || ext.length > 16) return chars.slice(0, max).join('');
  return [...chars.slice(0, max - ext.length), ...ext].join('');
}

/**
 * Nombre para `filename*`: UTF-16 bien formado (un surrogate suelto pasa a
 * U+FFFD, como `toWellFormed()`; si no, `encodeURIComponent` lanza), sin
 * comillas, barras invertidas ni caracteres de control (CR/LF incluidos: nada
 * de inyectar cabeceras), y como mucho 255 caracteres.
 */
function sanitizeFilename(filename: string): string {
  const wellFormed = filename.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '�',
  );
  // eslint-disable-next-line no-control-regex
  const clean = wellFormed.replace(/["\\\u0000-\u001f\u007f-\u009f]/g, '');
  return capLength(clean.trim(), MAX_FILENAME_LENGTH);
}

/**
 * Fallback ASCII del `filename="…"`: sin tildes (ñ → n) y todo lo que no sea
 * ASCII imprimible sin `"` ni `\` pasa a `_`. El filtro va DESPUÉS de NFKD:
 * NFKD convierte U+FF02/U+FF3C (de ancho completo) en `"` y `\`, y antes
 * permitían cerrar la comilla e inyectar otro `filename=`. NFKD también
 * expande (U+FDFA son 18 letras), así que se recorta otra vez al final.
 */
function asciiFallback(filename: string): string {
  const ascii = Array.from(filename.normalize('NFKD').replace(/[̀-ͯ]/g, ''))
    .map((c) => (/^[\x20\x21\x23-\x5b\x5d-\x7e]$/.test(c) ? c : '_'))
    .join('');
  return capLength(ascii, MAX_FILENAME_LENGTH);
}

/** RFC 5987: percent-encoding en UTF-8 de todo lo que no sea attr-char. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Valor de `Content-Disposition` (RFC 6266) para una URL firmada (DX-151):
 * `inline; filename="radio n.pdf"; filename*=UTF-8''radio%20%C3%B1.pdf`.
 * `filename` es el fallback ASCII para clientes viejos; los navegadores
 * actuales usan `filename*`, con el nombre original en UTF-8.
 */
export function contentDispositionHeader(options: SignedUrlOptions): string {
  const name = options.filename ? sanitizeFilename(options.filename) : '';
  if (!name) return options.disposition;
  return `${options.disposition}; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}
