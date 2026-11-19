import type { AppointmentStatus, CancellationReasonCode } from '@prisma/client';
import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { CivilPeriod } from '../comparison-period';
import type {
  CollectedAmount,
  ProducedAmount,
} from '../professional-productivity';

/** Una sede que quien consulta puede ver (DX-089), viva (activa o no). */
export interface ProfessionalReportLocation {
  id: string;
  name: string;
  isActive: boolean;
}

export interface ProfessionalReportOption {
  userId: string;
  fullName: string;
}

/**
 * A qué se acota: las sedes (de la cita, o donde se realizó el ítem) y, si
 * se da, el profesional (el de la cita, o quien realizó el ítem).
 */
export interface ProfessionalReportScope {
  locationIds: readonly string[];
  professionalId?: string;
}

/** Las citas que cuentan para el no-show % de un profesional. */
export interface ProfessionalAttendance {
  professionalId: string;
  completed: number;
  noShow: number;
  lateCancellations: number;
}

/** Lo sumado del período, por profesional (solo quien tiene algo). */
export interface ProfessionalPeriodSums {
  production: (ProducedAmount & { professionalId: string })[];
  collected: (CollectedAmount & { professionalId: string })[];
  attendance: ProfessionalAttendance[];
  /** Nombre de cada profesional que sale arriba. */
  names: Map<string, string>;
}

export type MissedAppointmentKind = 'NO_SHOW' | 'LATE_CANCELLATION';

/** Una cita no asistida o cancelada tarde del período. */
export interface MissedAppointmentRow {
  appointmentId: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  kind: MissedAppointmentKind;
  /** Motivo de la cancelación (DX-279); null en las inasistencias. */
  cancelReasonCode: CancellationReasonCode | null;
  /** Minutos de aviso de la cancelación; null en las inasistencias. */
  noticeMinutes: number | null;
  patientId: string;
  patientName: string;
  /** Archivado: la web no enlaza a su ficha (la cita sí). */
  patientArchived: boolean;
  appointmentTypeName: string | null;
  professionalId: string;
  professionalName: string | null;
  locationId: string;
  locationName: string;
  timeZone: string;
}

export const PROFESSIONAL_REPORTS_REPOSITORY = Symbol(
  'PROFESSIONAL_REPORTS_REPOSITORY',
);

export interface ProfessionalReportsRepository {
  /** Sedes vivas de la clínica que el usuario ve, en orden de creación. */
  listLocations(
    allowed: AllowedLocations,
  ): Promise<ProfessionalReportLocation[]>;
  /** ¿Es una sede viva de la clínica en contexto? */
  locationInClinic(locationId: string): Promise<boolean>;
  /**
   * Quien atiende citas o realizó procedimientos en esas sedes (también los
   * ex-miembros: su historia sigue contando), por nombre.
   */
  listProfessionals(
    locationIds: readonly string[],
  ): Promise<ProfessionalReportOption[]>;
  /** Producción, cobrado y citas del período por profesional. */
  sums(
    period: CivilPeriod,
    scope: ProfessionalReportScope,
  ): Promise<ProfessionalPeriodSums>;
  /** Solo las citas (para «Inasistencias»). */
  attendance(
    period: CivilPeriod,
    scope: ProfessionalReportScope,
  ): Promise<ProfessionalAttendance[]>;
  /** Citas no asistidas y canceladas tarde, de la más reciente a la más antigua. */
  listMissed(
    period: CivilPeriod,
    scope: ProfessionalReportScope,
    page: { skip: number; take: number },
  ): Promise<{ items: MissedAppointmentRow[]; total: number }>;
}
