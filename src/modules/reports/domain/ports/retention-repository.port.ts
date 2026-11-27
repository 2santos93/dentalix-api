import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type {
  RetentionBounds,
  RetentionFacts,
  RetentionSegment,
} from '../retention';

/** Una sede viva que quien consulta puede ver (DX-089). */
export interface RetentionLocation {
  id: string;
  name: string;
  isActive: boolean;
}

export interface RetentionProfessionalOption {
  userId: string;
  fullName: string;
}

/** Los cortes del período en la zona de una sede. */
export interface RetentionLocationBounds extends RetentionBounds {
  locationId: string;
}

/**
 * Lo que pide el informe: los cortes de TODAS las sedes de la clínica con
 * zona (la historia del paciente puede estar en cualquiera), las sedes a las
 * que se atribuye (las visibles, o la pedida) y, si se da, el profesional.
 */
export interface RetentionQuery {
  bounds: readonly RetentionLocationBounds[];
  locationIds: readonly string[];
  providerId?: string;
  /** «Ahora» de la cita futura agendada. */
  now: Date;
}

/** Cuántos pacientes de una sede y profesional tienen esos hechos. */
export interface RetentionFactsGroup {
  locationId: string;
  locationName: string;
  providerId: string;
  /** null si el usuario no tiene nombre legible (no debería pasar). */
  providerName: string | null;
  facts: RetentionFacts;
  count: number;
}

/** Un paciente de una lista. */
export interface RetentionPatientRow {
  patientId: string;
  patientName: string;
  phone: string | null;
  /** Región telefónica por defecto de la sede (lectura del wa.me). */
  phoneRegion: string | null;
  /** DX-128: baja de los avisos (no se ofrece wa.me). */
  reminderOptedOut: boolean;
  firstVisitAt: Date;
  lastVisitAt: Date;
  locationId: string;
  locationName: string;
  providerId: string;
  providerName: string | null;
  hasUpcomingAppointment: boolean;
}

export const RETENTION_REPOSITORY = Symbol('RETENTION_REPOSITORY');

export interface RetentionRepository {
  /** Sedes vivas de la clínica que el usuario ve, en orden de creación. */
  listLocations(allowed: AllowedLocations): Promise<RetentionLocation[]>;
  /** ¿Es una sede viva de la clínica en contexto? */
  locationInClinic(locationId: string): Promise<boolean>;
  /** Quien atiende citas en esas sedes (también ex-miembros), por nombre. */
  listProfessionals(
    locationIds: readonly string[],
  ): Promise<RetentionProfessionalOption[]>;
  /**
   * Zona de cada sede de la clínica (también retiradas). Una sede sin zona
   * con citas da 409 `LOCATION_TIMEZONE_REQUIRED`; sin citas, se ignora.
   */
  locationZones(): Promise<ReadonlyMap<string, string>>;
  /** Los hechos por paciente, agrupados por sede, profesional y hechos. */
  factGroups(query: RetentionQuery): Promise<RetentionFactsGroup[]>;
  /** Los pacientes de una lista, de la última visita más reciente a la más antigua. */
  listPatients(
    query: RetentionQuery,
    segment: RetentionSegment,
    page: { skip: number; take: number },
  ): Promise<{ items: RetentionPatientRow[]; total: number }>;
}
