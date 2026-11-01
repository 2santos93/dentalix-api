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

const MIN_YEARS_KEY = 'PLATFORM_MIN_CLINICAL_RETENTION_YEARS';

/**
 * Regla estricta del mínimo de plataforma, la misma para el arranque
 * (`validateEnv`) y para `retention:raise-floor`: vacío = 15; si no, un entero
 * de 15 a 100. Devuelve el problema, o null si vale.
 */
export function platformMinYearsProblem(
  raw: string | undefined,
): string | null {
  const text = raw?.trim() ?? '';
  if (raw === undefined || raw === '') return null;
  const value = Number(text);
  if (
    !/^\d{1,3}$/.test(text) ||
    value < PLATFORM_FLOOR_YEARS ||
    value > MAX_RETENTION_YEARS
  ) {
    return `${MIN_YEARS_KEY} debe ser un entero entre ${PLATFORM_FLOOR_YEARS} y ${MAX_RETENTION_YEARS}.`;
  }
  return null;
}

/**
 * Mínimo de plataforma para quien NO pasó por `validateEnv` (el script de
 * `retention:raise-floor`): un valor inválido es un error, nunca se recorta ni
 * se sustituye por 15.
 */
export function resolvePlatformMinYears(
  get: (key: string) => string | undefined,
): number {
  const raw = get(MIN_YEARS_KEY);
  const problem = platformMinYearsProblem(raw);
  if (problem) throw new Error(problem);
  return loadClinicalRetentionConfig(get).platformMinYears;
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
