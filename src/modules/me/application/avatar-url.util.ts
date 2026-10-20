import { legacyUrlToKey } from '../../../shared/storage/file-key';
import type { FileStoragePort } from '../../../shared/storage/file-storage.port';

const AVATAR_KEY = /^avatars\/[^/]+$/;

/**
 * Clave del avatar guardado (DX-084). La columna guarda la clave; una URL
 * absoluta de antes de la migración (la escribiría una réplica antigua
 * durante un despliegue escalonado) se reduce a su clave. null si no hay
 * avatar o el valor no se reconoce. Solo claves `avatars/<nombre>`: borrar o
 * publicar el avatar nunca toca otro espacio del almacén (p. ej. lo clínico).
 */
export function avatarKeyOf(stored: string | null): string | null {
  const key = stored ? legacyUrlToKey(stored) : null;
  return key && AVATAR_KEY.test(key) ? key : null;
}

/** URL pública del avatar con la `FILES_PUBLIC_BASE_URL` vigente. */
export function avatarPublicUrl(
  storage: FileStoragePort,
  stored: string | null,
): string | null {
  const key = avatarKeyOf(stored);
  return key ? storage.publicUrl(key) : null;
}
