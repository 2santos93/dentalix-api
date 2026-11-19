import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { CivilPeriod } from '../comparison-period';
import type {
  AcquisitionCatalogSource,
  AcquisitionReferrerAmount,
  AcquisitionReferrerSums,
  AcquisitionSourceAmount,
  AcquisitionSourceSums,
} from '../acquisition';

export const ACQUISITION_REPOSITORY = Symbol('ACQUISITION_REPOSITORY');

export interface AcquisitionLocation {
  id: string;
  name: string;
  isActive: boolean;
}

/**
 * El alcance del informe: las sedes cuyos pacientes (por su sede de
 * captación) y cuyos abonos cuentan, y si entran los pacientes sin sede de
 * captación (sin ninguna cita): solo quien ve todas, sin elegir una.
 */
export interface AcquisitionScope {
  locationIds: string[];
  includeWithoutLocation: boolean;
}

export interface AcquisitionAggregate {
  catalog: AcquisitionCatalogSource[];
  sums: AcquisitionSourceSums[];
  sourceAmounts: AcquisitionSourceAmount[];
  referrers: AcquisitionReferrerSums[];
  referrerAmounts: AcquisitionReferrerAmount[];
}

export interface AcquisitionRepository {
  listLocations(allowed: AllowedLocations): Promise<AcquisitionLocation[]>;
  locationInClinic(locationId: string): Promise<boolean>;
  aggregate(
    period: CivilPeriod,
    scope: AcquisitionScope,
    topReferrers: number,
  ): Promise<AcquisitionAggregate>;
}
