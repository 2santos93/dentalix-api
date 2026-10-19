import { legacyUrlToKey } from '../../../shared/storage/file-key';
import type { FileStoragePort } from '../../../shared/storage/file-storage.port';

/**
 * Clave del avatar guardado (DX-084). La columna guarda la clave; una URL
 * absoluta de antes de la migración (la escribiría una réplica antigua
 * durante un despliegue escalonado) se reduce a su clave. null si no hay
 * avatar o el valor no se reconoce.
 */
export function avatarKeyOf(stored: string | null): string | null {
  return stored ? legacyUrlToKey(stored) : null;
}

/** URL pública del avatar con la `FILES_PUBLIC_BASE_URL` vigente. */
export function avatarPublicUrl(
  storage: FileStoragePort,
  stored: string | null,
): string | null {
  const key = avatarKeyOf(stored);
  return key ? storage.publicUrl(key) : null;
}
