import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { CivilPeriod } from '../comparison-period';
import type {
  BookedMinutes,
  ProviderLocationCapacity,
  TimingAggregate,
} from '../timing';

/** Una sede viva que quien consulta puede ver (DX-089). */
export interface TimingLocation {
  id: string;
  name: string;
  isActive: boolean;
}

export interface TimingProfessionalOption {
  userId: string;
  fullName: string;
}

/** Qué se consulta: las sedes del informe y, si se da, el profesional. */
export interface TimingScope {
  locationIds: readonly string[];
  providerId?: string;
}

/** La dimensión de una fila agregada (GROUPING SETS). */
export type TimingGroupSet = 'TOTAL' | 'PROFESSIONAL' | 'TYPE' | 'WEEK';

export interface TimingGroupRow extends TimingAggregate {
  set: TimingGroupSet;
  /** Solo en PROFESSIONAL. */
  providerId: string | null;
  /** Solo en TYPE; null también en la fila «Sin tipo». */
  appointmentTypeId: string | null;
  /** Solo en WEEK: lunes de la semana en la zona de la sede. */
  weekStart: string | null;
}

export interface TimingAppointmentType {
  name: string;
  /** Duración del catálogo (DX-121), la de hoy. */
  durationMinutes: number;
}

export interface TimingData {
  groups: TimingGroupRow[];
  booked: BookedMinutes[];
  capacities: ProviderLocationCapacity[];
  /** Nombre de cada profesional que aparece. */
  names: ReadonlyMap<string, string>;
  /** Los tipos de cita que aparecen (también los retirados). */
  types: ReadonlyMap<string, TimingAppointmentType>;
}

export const TIMING_REPOSITORY = Symbol('TIMING_REPOSITORY');

export interface TimingRepository {
  /** ¿Sede viva de la clínica? */
  locationInClinic(locationId: string): Promise<boolean>;
  listLocations(allowed: AllowedLocations): Promise<TimingLocation[]>;
  /** Quien tiene citas u horario en esas sedes. */
  listProfessionals(
    locationIds: readonly string[],
  ): Promise<TimingProfessionalOption[]>;
  /** Todo el informe en una transacción REPEATABLE READ (la misma foto). */
  load(period: CivilPeriod, scope: TimingScope): Promise<TimingData>;
}
