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
  /** `Content-Type` de la respuesta; sin él, el guardado (S3) o la extensión (disco). */
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
   * pueden cambiar en la URL sin invalidarla (DX-151).
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

/** Longitud máxima del nombre en la cabecera (la de un nombre de fichero). */
const MAX_FILENAME_LENGTH = 255;

/**
 * Quita lo que no puede ir en el nombre de la cabecera: comillas, barras
 * invertidas y caracteres de control (CR/LF incluidos: nada de inyectar
 * cabeceras). Recorta a 255 caracteres conservando la extensión.
 */
function sanitizeFilename(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = filename.replace(/["\\\u0000-\u001f\u007f-\u009f]/g, '').trim();
  const chars = Array.from(clean);
  if (chars.length <= MAX_FILENAME_LENGTH) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 ? Array.from(clean.slice(dot)) : [];
  if (ext.length === 0 || ext.length > 16) {
    return chars.slice(0, MAX_FILENAME_LENGTH).join('');
  }
  return [...chars.slice(0, MAX_FILENAME_LENGTH - ext.length), ...ext].join('');
}

/** Fallback ASCII: sin tildes (ñ → n) y lo que no sea ASCII imprimible → `_`. */
function asciiFallback(filename: string): string {
  return Array.from(filename.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''))
    .map((c) => (/^[\x20-\x7e]$/.test(c) ? c : '_'))
    .join('');
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
