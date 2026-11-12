import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { CivilPeriod } from '../comparison-period';
import type { PatientLinkCounts, PatientLinkType } from '../patient-links';

/** Cuentas de un tipo en una sede (`locationId`) o en todas (`null`). */
export interface PatientLinkCountsRow extends PatientLinkCounts {
  linkType: PatientLinkType;
  locationId: string | null;
}

export interface PatientLinksLocation {
  locationId: string;
  locationName: string;
  timeZone: string;
}

export interface PatientLinksData {
  /** Sedes con zona horaria válida, por fecha de alta. */
  locations: PatientLinksLocation[];
  rows: PatientLinkCountsRow[];
}

export const PATIENT_LINKS_REPOSITORY = Symbol('PATIENT_LINKS_REPOSITORY');

export interface PatientLinksRepository {
  /** Ids de las sedes vivas de la clínica que el usuario ve. */
  listLocationIds(allowed: AllowedLocations): Promise<string[]>;
  /** ¿La sede es de la clínica en contexto (viva)? */
  locationInClinic(locationId: string): Promise<boolean>;
  /** `asOf`: el instante con el que se decide si un enlace ya caducó. */
  load(
    period: CivilPeriod,
    locationIds: readonly string[],
    asOf: Date,
  ): Promise<PatientLinksData>;
}
