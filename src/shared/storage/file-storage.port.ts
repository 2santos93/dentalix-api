export const FILE_STORAGE = Symbol('FILE_STORAGE');

export interface FileStoragePort {
  /** Persiste `bytes` en `<namespace>/<filename>` y devuelve la URL pública para leerlo. */
  save(
    namespace: string,
    filename: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<{ url: string }>;

  /** Borra `<namespace>/<filename>`. Idempotente: no falla si no existe. */
  delete(namespace: string, filename: string): Promise<void>;
}
