import * as path from 'path';

/** Tipos que la API sirve por extensión (avatares y documentos del paciente, DX-151). */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  // Fotos de iPhone, informes de Word y radiografías DICOM (DX-151).
  '.heic': 'image/heic',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.dcm': 'application/dicom',
};

/** Tipo por la extensión de la clave; `application/octet-stream` si no se conoce. */
export function contentTypeOf(key: string): string {
  return (
    MIME_BY_EXT[path.extname(key).toLowerCase()] ?? 'application/octet-stream'
  );
}

const SERVABLE_TYPES = new Set(Object.values(MIME_BY_EXT));

/**
 * true si `type` es uno de los tipos de la lista blanca (DX-151). Una URL
 * firmada solo puede forzar uno de estos: nunca `text/html`, `image/svg+xml`
 * ni nada que el navegador ejecute.
 */
export function isServableContentType(type: string): boolean {
  return SERVABLE_TYPES.has(type);
}
