import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { ClinicProfile, ClinicProfilePatch } from '../clinic-settings';

export const CLINIC_SETTINGS_REPOSITORY = Symbol('CLINIC_SETTINGS_REPOSITORY');

/** La fila de la clínica tal como la usa Ajustes › Datos de la clínica. */
export interface StoredClinicSettings {
  profile: ClinicProfile;
  /** URL pública del logo (la que leen los documentos), o `null`. */
  logoUrl: string | null;
  /** Clave del logo subido desde Ajustes (DX-084), o `null`. */
  logoKey: string | null;
}

/**
 * DX-019. Cada escritura bloquea la fila de la clínica y escribe su evento de
 * auditoría (antes y después) en la MISMA transacción; sin cambio, sin evento.
 */
export interface ClinicSettingsRepository {
  get(): Promise<StoredClinicSettings>;
  updateProfile(
    patch: ClinicProfilePatch,
    ctx: AuditRequestContext,
  ): Promise<StoredClinicSettings>;
  /** `logo` null = quitarlo. */
  setLogo(
    logo: { key: string; url: string } | null,
    ctx: AuditRequestContext,
  ): Promise<StoredClinicSettings>;
}
