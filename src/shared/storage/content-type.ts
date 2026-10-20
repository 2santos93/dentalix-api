import * as path from 'path';

/** Tipos que la API sirve por extensión (avatares hoy; DX-008 añadirá PDF). */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/** Tipo por la extensión de la clave; `application/octet-stream` si no se conoce. */
export function contentTypeOf(key: string): string {
  return (
    MIME_BY_EXT[path.extname(key).toLowerCase()] ?? 'application/octet-stream'
  );
}
