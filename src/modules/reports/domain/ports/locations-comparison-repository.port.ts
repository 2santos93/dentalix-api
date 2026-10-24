import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { CivilPeriod } from '../comparison-period';
import type { PeriodAggregates } from '../kpi-definitions';

/** Una sede de la comparación, con la zona en la que corta sus días (DX-097). */
export interface ComparisonLocation {
  id: string;
  name: string;
  isActive: boolean;
  timeZone: string;
}

/** Las sumas de un período: por sede y, del conjunto, los pacientes distintos. */
export interface PeriodAggregation {
  byLocation: ReadonlyMap<string, PeriodAggregates>;
  /**
   * Pacientes distintos con alguna cita atendida en CUALQUIERA de las sedes
   * pedidas (un paciente que fue a dos sedes cuenta una vez).
   */
  attendedPatients: number;
}

export const LOCATIONS_COMPARISON_REPOSITORY = Symbol(
  'LOCATIONS_COMPARISON_REPOSITORY',
);

export interface LocationsComparisonRepository {
  /**
   * Sedes vivas (activas o desactivadas, no retiradas) de la clínica en
   * contexto que el usuario puede ver (DX-089), en orden de creación.
   */
  listLocations(allowed: AllowedLocations): Promise<ComparisonLocation[]>;
  /**
   * Las sumas de `period` para esas sedes, en consultas agregadas (una por
   * fuente, nunca una por sede). Con `currency`, solo los importes en esa
   * moneda.
   */
  aggregate(
    period: CivilPeriod,
    locations: readonly ComparisonLocation[],
    currency?: string,
  ): Promise<PeriodAggregation>;
}
