import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { ClinicProfile, ClinicProfilePatch } from '../clinic-settings';

export const CLINIC_SETTINGS_REPOSITORY = Symbol('CLINIC_SETTINGS_REPOSITORY');

/** La fila de la clínica tal como la usa Ajustes › Datos de la clínica. */
export interface StoredClinicSettings {
  profile: ClinicProfile;
  /** Clave del logo en el almacén (DX-084), o una URL anterior a DX-019, o `null`. */
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
  /** `key` null = quitarlo. */
  setLogo(
    key: string | null,
    ctx: AuditRequestContext,
  ): Promise<StoredClinicSettings>;
}
