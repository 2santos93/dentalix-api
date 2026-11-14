import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { CivilPeriod } from '../comparison-period';
import type {
  AppointmentDayCount,
  FillCandidate,
  FreedSlot,
  MoneyAmount,
  OfferDayCount,
} from '../recovered-slots';

/** A qué se acota el informe: sedes visibles y, opcional, un profesional. */
export interface RecoveredSlotsScope {
  locationIds: readonly string[];
  providerId?: string;
}

export interface RecoveredSlotsProvider {
  providerId: string;
  providerName: string;
}

/** Lo que el informe lee de la BD para un período y un alcance. */
export interface RecoveredSlotsData {
  slots: FreedSlot[];
  candidates: FillCandidate[];
  /** Valor de cada cita candidata (ítems del plan ligados), por moneda. */
  values: Map<string, MoneyAmount[]>;
  counts: AppointmentDayCount[];
  offers: OfferDayCount[];
  providers: RecoveredSlotsProvider[];
}

export const RECOVERED_SLOTS_REPOSITORY = Symbol('RECOVERED_SLOTS_REPOSITORY');

export interface RecoveredSlotsRepository {
  /** Ids de las sedes vivas de la clínica que el usuario ve. */
  listLocationIds(allowed: AllowedLocations): Promise<string[]>;
  /** ¿La sede es de la clínica en contexto (viva)? */
  locationInClinic(locationId: string): Promise<boolean>;
  load(
    period: CivilPeriod,
    scope: RecoveredSlotsScope,
  ): Promise<RecoveredSlotsData>;
}
