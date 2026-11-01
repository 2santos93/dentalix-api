import { ConfigService } from '@nestjs/config';

export const CLINICAL_RETENTION_CONFIG = Symbol('CLINICAL_RETENTION_CONFIG');

/** Suelo del plazo de conservación (D1): el mismo del CHECK de la BD. */
export const PLATFORM_FLOOR_YEARS = 15;
/** Techo del plazo de conservación: el mismo del CHECK de la BD. */
export const MAX_RETENTION_YEARS = 100;

export interface ClinicalRetentionConfig {
  /** Mínimo de plataforma en años; nunca menos de PLATFORM_FLOOR_YEARS. */
  platformMinYears: number;
}

/**
 * Configuración del plazo de conservación de la historia clínica (DX-330), a
 * partir del entorno ya validado por `validateEnv`:
 * `PLATFORM_MIN_CLINICAL_RETENTION_YEARS` (vacío = 15).
 */
export function loadClinicalRetentionConfig(
  get: (key: string) => string | undefined,
): ClinicalRetentionConfig {
  const raw = get('PLATFORM_MIN_CLINICAL_RETENTION_YEARS')?.trim();
  const value =
    raw && /^\d{1,3}$/.test(raw) ? Number(raw) : PLATFORM_FLOOR_YEARS;
  return {
    platformMinYears: Math.min(
      MAX_RETENTION_YEARS,
      Math.max(PLATFORM_FLOOR_YEARS, value),
    ),
  };
}

/** Provider compartido por AuthModule y PatientsModule (función pura, sin estado). */
export const clinicalRetentionConfigProvider = {
  provide: CLINICAL_RETENTION_CONFIG,
  inject: [ConfigService],
  useFactory: (config: ConfigService): ClinicalRetentionConfig =>
    loadClinicalRetentionConfig((key) => config.get<string>(key)),
};
