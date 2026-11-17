import type { AppointmentStatus } from '@prisma/client';
import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { CivilPeriod } from '../comparison-period';
import type {
  ForecastAmountGroup,
  ScheduledAmountGroup,
  ScheduledAppointmentGroup,
} from '../scheduled-production';

/** Una sede que quien consulta puede ver (DX-089), viva (activa o no). */
export interface ScheduledProductionLocation {
  id: string;
  name: string;
  isActive: boolean;
}

/** Quien atiende alguna cita viva en esas sedes (miembro vivo). */
export interface ScheduledProductionProfessional {
  userId: string;
  fullName: string;
}

/**
 * A qué se acota: sedes de la cita (o de la realización), si entran los
 * realizados sin sede (solo quien ve todas y sin elegir una) y el
 * profesional (el de la cita; en lo producido, quien lo realizó).
 */
export interface ScheduledProductionScope {
  locationIds: readonly string[];
  includeWithoutLocation: boolean;
  professionalId?: string;
  /** Moneda del catálogo: los grupos en ella no llevan ids de citas. */
  currency: string | null;
}

/** Lo agendado del período. */
export interface ScheduledAggregate {
  amounts: ScheduledAmountGroup[];
  appointments: ScheduledAppointmentGroup[];
  /** Nombre de cada profesional que sale en las citas. */
  names: Map<string, string>;
  /** Zona de cada sede del alcance con zona válida. */
  zones: Map<string, string>;
}

/** Hoy y el mes en curso de cada zona del alcance. */
export interface ForecastWindow {
  /** Zona → sus sedes, su hoy y su mes. */
  zones: {
    timeZone: string;
    locationIds: string[];
    today: string;
    monthFirst: string;
    monthLast: string;
  }[];
  /** La sede de referencia (la elegida o la principal) y su hoy. */
  reference: { timeZone: string; today: string };
}

export interface ForecastAggregate {
  window: ForecastWindow;
  /** Realizados del mes hasta hoy, por día de realización. */
  produced: ForecastAmountGroup[];
  /** Aceptados en citas de hoy a fin de mes, por día de la cita. */
  pending: ForecastAmountGroup[];
  /** Realizados sin sede o sin fecha: fuera de lo producido. */
  unattributedDone: number;
}

/** Una cita sin tratamiento ligado. */
export interface UnlinkedAppointmentRow {
  appointmentId: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  /** Vivo o archivado: las citas de un archivado también cuentan. */
  patientId: string;
  patientName: string;
  /** Paciente archivado: la web no enlaza a su ficha. */
  patientArchived: boolean;
  appointmentTypeName: string | null;
  professionalId: string;
  professionalName: string | null;
  locationId: string;
  locationName: string;
  timeZone: string;
}

export const SCHEDULED_PRODUCTION_REPOSITORY = Symbol(
  'SCHEDULED_PRODUCTION_REPOSITORY',
);

export interface ScheduledProductionRepository {
  /** Sedes vivas de la clínica que el usuario ve, en orden de creación. */
  listLocations(
    allowed: AllowedLocations,
  ): Promise<ScheduledProductionLocation[]>;
  /** ¿Es una sede viva de la clínica en contexto? */
  locationInClinic(locationId: string): Promise<boolean>;
  /** Miembros vivos que atienden alguna cita viva en esas sedes, por nombre. */
  listProfessionals(
    locationIds: readonly string[],
  ): Promise<ScheduledProductionProfessional[]>;
  /** Lo agendado del período, por (día, profesional, sede[, moneda]). */
  scheduled(
    period: CivilPeriod,
    scope: ScheduledProductionScope,
  ): Promise<ScheduledAggregate>;
  /** Producido hasta hoy y agendado pendiente del mes en curso de cada sede. */
  forecast(
    now: Date,
    scope: ScheduledProductionScope,
    referenceLocationId: string | null,
  ): Promise<ForecastAggregate>;
  /** Las citas sin tratamiento ligado del período, por inicio. */
  listUnlinked(
    period: CivilPeriod,
    scope: ScheduledProductionScope,
    page: { skip: number; take: number },
  ): Promise<{ items: UnlinkedAppointmentRow[]; total: number }>;
}
