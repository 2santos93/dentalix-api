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

/**
 * DX-019-bis (B): lo que una receta o una aceptación firmada (y, desde
 * DX-019-ter, un consentimiento firmado o una entrega post-operatoria) congela
 * del logo al emitirse: la clave (o la URL http(s) anterior) si hoy se puede pintar; si
 * no, `null`, que es «emitido sin logo» (nunca se cae al logo de hoy). Mismo
 * criterio que el CHECK de `prescriptions."clinicLogoKey"` y
 * `treatment_plan_acceptances."clinicLogoKey"` (20261203090000_dx019b_clinic_logo_key)
 * y de `patient_consents` / `post_op_instruction_deliveries`
 * (20261214090000_dx019t_clinic_logo_key), así que congelar nunca hace fallar
 * una emisión.
 */
export function clinicLogoKeyToFreeze(stored: string | null): string | null {
  return clinicLogoPublicUrl(stored) === null ? null : stored;
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
