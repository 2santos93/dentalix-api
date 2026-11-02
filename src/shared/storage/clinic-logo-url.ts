import { isFileKey, publicFileUrl } from './file-key';
import { DEFAULT_FILES_PUBLIC_BASE_URL } from './storage-config';

const LOGO_KEY = /^logos\/[^/]+$/;

/**
 * DX-019 (DX-084): en la BD va la CLAVE del logo (`logos/<clínica>-<hex>.<ext>`)
 * y la URL se calcula al responder con la `FILES_PUBLIC_BASE_URL` vigente, así
 * que cambiar de dominio no rompe nada. Una URL http(s) absoluta (columna
 * `logoUrl` anterior a la subida desde Ajustes) sale tal cual. Lo demás, `null`.
 *
 * Lee el entorno y no `FILE_STORAGE` porque la usan ~15 repositorios de módulos
 * que no dependen del almacén; `validateEnv` ya exige la variable en producción.
 */
export function clinicLogoPublicUrl(stored: string | null): string | null {
  if (!stored) return null;
  if (LOGO_KEY.test(stored) && isFileKey(stored)) {
    return publicFileUrl(
      process.env.FILES_PUBLIC_BASE_URL ?? DEFAULT_FILES_PUBLIC_BASE_URL,
      stored,
    );
  }
  return /^https?:\/\//i.test(stored) ? stored : null;
}

type WithLogoUrl<T> = Omit<T, 'logoKey'> & { logoUrl: string | null };

/** La fila de `tenants` con `logoKey` convertida en `logoUrl`. */
export function withClinicLogoUrl<T extends { logoKey: string | null }>(
  row: T,
): WithLogoUrl<T>;
export function withClinicLogoUrl<T extends { logoKey: string | null }>(
  row: T | null,
): WithLogoUrl<T> | null;
export function withClinicLogoUrl<T extends { logoKey: string | null }>(
  row: T | null,
): WithLogoUrl<T> | null {
  if (!row) return null;
  const { logoKey, ...rest } = row;
  return { ...rest, logoUrl: clinicLogoPublicUrl(logoKey) };
}
