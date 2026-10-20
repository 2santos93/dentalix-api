export const FILE_STORAGE = Symbol('FILE_STORAGE');

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
   * `ttlSeconds` (1 s – 7 días, el máximo de S3 con SigV4).
   */
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
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
