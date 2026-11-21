import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { ClinicCurrencies } from '../clinic-currencies';

export const CLINIC_CURRENCIES_REPOSITORY = Symbol(
  'CLINIC_CURRENCIES_REPOSITORY',
);

/** La sede con la que se calcula el menú: su zona («hoy») y su moneda. */
export interface HeaderLocation {
  timeZone: string;
  currency: string | null;
}

/** DX-584: las monedas de la clínica del contexto (`tenants`). */
export interface ClinicCurrenciesRepository {
  get(): Promise<ClinicCurrencies>;
  /**
   * Lee con la fila de la clínica bloqueada, escribe lo que devuelve
   * `next(before)` y audita el antes y el después (CLINIC_SETTINGS,
   * CLINIC_CURRENCIES) en la MISMA transacción; sin cambio, sin evento.
   */
  set(
    next: (before: ClinicCurrencies) => ClinicCurrencies,
    ctx: AuditRequestContext,
  ): Promise<{ before: ClinicCurrencies; after: ClinicCurrencies }>;
  /** Los códigos de `codes` que están en `currencies`. */
  knownCurrencies(codes: readonly string[]): Promise<Set<string>>;
  /** Monedas de las sedes no borradas de la clínica (sin repetir). */
  locationCurrencies(): Promise<string[]>;
  /**
   * La sede activa del contexto o, sin ella, la principal (G1, R6). null si
   * la clínica no tiene sede utilizable (sin sedes activas o sin zona).
   */
  headerLocation(): Promise<HeaderLocation | null>;
}
