import type { FileStoragePort } from '../../../shared/storage/file-storage.port';

const FROZEN_LOGO_KEY = /^logos\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * DX-572: lee del almacén los bytes del logo congelado en la orden
 * (`clinicLogoKey`, DX-019-bis). Solo LEE: un logo nunca se borra. Solo una
 * clave `logos/…` (una URL http(s) anterior a la subida desde Ajustes no se
 * descarga desde el servidor); sin logo, o si no se puede leer, la orden se
 * imprime igual, sin él.
 */
export async function loadFrozenLogo(
  storage: Pick<FileStoragePort, 'read'>,
  key: string | null,
): Promise<Buffer | null> {
  if (!key || !FROZEN_LOGO_KEY.test(key) || key.includes('..')) return null;
  try {
    return (await storage.read(key))?.bytes ?? null;
  } catch {
    return null;
  }
}
