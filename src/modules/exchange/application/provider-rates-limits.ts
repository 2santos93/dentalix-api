// Sin dependencias de Nest: lo importa también la validación del arranque
// (`src/config/env.validation.ts`).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Topes de las llamadas al proveedor de tasas (SEC-054, SEC-058); ver `.env.example`. */
export interface ProviderRatesLimits {
  /** Cuánto se recuerda que un día no lo tiene el proveedor (o falló). */
  negativeTtlMs: number;
  /** Llamadas por clínica en su ventana (fallos de caché, no peticiones). */
  clinic: { limit: number; windowMs: number };
  /** SEC-058: llamadas de una clínica en la ventana global. */
  clinicDaily: number;
  /**
   * SEC-058: una clínica dada de alta hace menos de `days` días tiene, en la
   * ventana global, `limit` en vez de `clinicDaily`.
   */
  newClinic: { days: number; limit: number };
  /**
   * Llamadas de todas las clínicas juntas en la ventana. La precarga diaria
   * no cuenta ni se corta: es la reserva del plan contratado.
   */
  global: { limit: number; windowMs: number };
  /**
   * SEC-058: `reserve` llamadas del global solo para el barrido de reintentos
   * (las peticiones paran en `global.limit - reserve`), y como mucho
   * `clinicLimit` del barrido de una misma clínica en la ventana global.
   */
  sweep: { reserve: number; clinicLimit: number };
}

export const PROVIDER_RATES_LIMITS = Symbol('PROVIDER_RATES_LIMITS');

// El global por defecto es ~75 % de la cuota diaria prorrateada del plan
// «Developer» de Open Exchange Rates (10.000/mes); con otro plan se ajusta.
// Por clínica, 40 al día (16 % del global) y 5 si es nueva: con la reserva
// del barrido, hacen falta 5 clínicas antiguas (o 40 nuevas) para dejar sin
// tasa a las demás, y el barrido sigue con sus 50.
export const DEFAULT_PROVIDER_RATES_LIMITS: ProviderRatesLimits = {
  negativeTtlMs: HOUR,
  clinic: { limit: 30, windowMs: HOUR },
  clinicDaily: 40,
  newClinic: { days: 30, limit: 5 },
  global: { limit: 250, windowMs: 24 * HOUR },
  sweep: { reserve: 50, clinicLimit: 10 },
};

type EnvReader = (key: string) => string | undefined;

/** Variable, valor por defecto y máximo (los enteros son ≥ 1). */
const LIMIT_VARS = {
  EXCHANGE_NEGATIVE_CACHE_TTL_MS: [
    DEFAULT_PROVIDER_RATES_LIMITS.negativeTtlMs,
    7 * 24 * HOUR,
  ],
  EXCHANGE_PROVIDER_CLINIC_LIMIT: [
    DEFAULT_PROVIDER_RATES_LIMITS.clinic.limit,
    100_000,
  ],
  EXCHANGE_PROVIDER_CLINIC_WINDOW_MS: [
    DEFAULT_PROVIDER_RATES_LIMITS.clinic.windowMs,
    31 * 24 * HOUR,
  ],
  EXCHANGE_PROVIDER_CLINIC_DAILY_LIMIT: [
    DEFAULT_PROVIDER_RATES_LIMITS.clinicDaily,
    100_000,
  ],
  EXCHANGE_PROVIDER_NEW_CLINIC_DAYS: [
    DEFAULT_PROVIDER_RATES_LIMITS.newClinic.days,
    3650,
  ],
  EXCHANGE_PROVIDER_NEW_CLINIC_LIMIT: [
    DEFAULT_PROVIDER_RATES_LIMITS.newClinic.limit,
    100_000,
  ],
  EXCHANGE_PROVIDER_GLOBAL_LIMIT: [
    DEFAULT_PROVIDER_RATES_LIMITS.global.limit,
    1_000_000,
  ],
  EXCHANGE_PROVIDER_GLOBAL_WINDOW_MS: [
    DEFAULT_PROVIDER_RATES_LIMITS.global.windowMs,
    31 * 24 * HOUR,
  ],
  EXCHANGE_PROVIDER_SWEEP_RESERVE: [
    DEFAULT_PROVIDER_RATES_LIMITS.sweep.reserve,
    1_000_000,
  ],
  EXCHANGE_PROVIDER_SWEEP_CLINIC_LIMIT: [
    DEFAULT_PROVIDER_RATES_LIMITS.sweep.clinicLimit,
    100_000,
  ],
} as const satisfies Record<string, readonly [number, number]>;

type LimitVar = keyof typeof LIMIT_VARS;

function readLimits(env: EnvReader): {
  limits: ProviderRatesLimits;
  problems: string[];
} {
  const problems: string[] = [];
  const read = (key: LimitVar): number => {
    const [fallback, max] = LIMIT_VARS[key];
    const raw = env(key)?.trim();
    if (raw == null || raw === '') return fallback;
    if (!/^\d{1,10}$/.test(raw) || Number(raw) < 1 || Number(raw) > max) {
      problems.push(
        `${key} debe ser un entero entre 1 y ${max} (recibido "${raw}").`,
      );
      return fallback;
    }
    return Number(raw);
  };
  const limits: ProviderRatesLimits = {
    negativeTtlMs: read('EXCHANGE_NEGATIVE_CACHE_TTL_MS'),
    clinic: {
      limit: read('EXCHANGE_PROVIDER_CLINIC_LIMIT'),
      windowMs: read('EXCHANGE_PROVIDER_CLINIC_WINDOW_MS'),
    },
    clinicDaily: read('EXCHANGE_PROVIDER_CLINIC_DAILY_LIMIT'),
    newClinic: {
      days: read('EXCHANGE_PROVIDER_NEW_CLINIC_DAYS'),
      limit: read('EXCHANGE_PROVIDER_NEW_CLINIC_LIMIT'),
    },
    global: {
      limit: read('EXCHANGE_PROVIDER_GLOBAL_LIMIT'),
      windowMs: read('EXCHANGE_PROVIDER_GLOBAL_WINDOW_MS'),
    },
    sweep: {
      reserve: read('EXCHANGE_PROVIDER_SWEEP_RESERVE'),
      clinicLimit: read('EXCHANGE_PROVIDER_SWEEP_CLINIC_LIMIT'),
    },
  };
  if (problems.length > 0) return { limits, problems };
  const { global, sweep, clinicDaily, newClinic } = limits;
  if (sweep.reserve >= global.limit) {
    problems.push(
      `EXCHANGE_PROVIDER_SWEEP_RESERVE (${sweep.reserve}) debe ser menor que EXCHANGE_PROVIDER_GLOBAL_LIMIT (${global.limit}): si no, las peticiones de las clínicas no tienen cupo.`,
    );
  }
  if (sweep.clinicLimit > sweep.reserve) {
    problems.push(
      `EXCHANGE_PROVIDER_SWEEP_CLINIC_LIMIT (${sweep.clinicLimit}) no puede pasar de EXCHANGE_PROVIDER_SWEEP_RESERVE (${sweep.reserve}): una clínica no puede gastar más que toda la reserva del barrido.`,
    );
  }
  if (clinicDaily > global.limit - sweep.reserve) {
    problems.push(
      `EXCHANGE_PROVIDER_CLINIC_DAILY_LIMIT (${clinicDaily}) no puede pasar del global sin la reserva del barrido (${global.limit - sweep.reserve}).`,
    );
  }
  if (newClinic.limit > clinicDaily) {
    problems.push(
      `EXCHANGE_PROVIDER_NEW_CLINIC_LIMIT (${newClinic.limit}) no puede pasar de EXCHANGE_PROVIDER_CLINIC_DAILY_LIMIT (${clinicDaily}): es el tope reducido.`,
    );
  }
  return { limits, problems };
}

/** SEC-058: lo que `validateEnv` comprueba al arrancar (mensajes en español). */
export function providerRatesLimitsProblems(env: EnvReader): string[] {
  return readLimits(env).problems;
}

export function loadProviderRatesLimits(env: EnvReader): ProviderRatesLimits {
  const { limits, problems } = readLimits(env);
  if (problems.length > 0) {
    throw new Error(`Configuración inválida: ${problems.join(' ')}`);
  }
  return limits;
}
