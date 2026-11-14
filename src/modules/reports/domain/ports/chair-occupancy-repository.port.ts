import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { CivilPeriod } from '../comparison-period';
import type {
  OccupancyAppointment,
  OccupancyChair,
  OccupancyHoliday,
} from '../chair-occupancy';
import type { Closure, WeeklyRange } from '../open-minutes';

/** Lo que el informe lee de UNA sede para el período. */
export interface ChairOccupancyLocationData {
  locationId: string;
  locationName: string;
  timeZone: string;
  /** Tramos semanales vivos del horario de la sede; vacío = sin horario. */
  ranges: WeeklyRange[];
  /** Cierres de toda la sede que tocan el período. */
  closures: Closure[];
  /** Festivos vivos de la sede. */
  holidays: OccupancyHoliday[];
  /** Todos los sillones de la sede (activos e inactivos). */
  chairs: OccupancyChair[];
  /** Citas vivas no canceladas de la sede que tocan el período. */
  appointments: OccupancyAppointment[];
}

export const CHAIR_OCCUPANCY_REPOSITORY = Symbol('CHAIR_OCCUPANCY_REPOSITORY');

export interface ChairOccupancyRepository {
  /** Ids de las sedes vivas de la clínica que el usuario ve. */
  listLocationIds(allowed: AllowedLocations): Promise<string[]>;
  /** ¿La sede es de la clínica en contexto (viva)? */
  locationInClinic(locationId: string): Promise<boolean>;
  /** Una entrada por sede con zona válida, en el orden de `locationIds`. */
  load(
    period: CivilPeriod,
    locationIds: readonly string[],
  ): Promise<ChairOccupancyLocationData[]>;
}
