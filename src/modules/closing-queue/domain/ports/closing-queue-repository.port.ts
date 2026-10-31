import type {
  AppointmentStatus,
  ClosingQueueSection,
  ToothSurface,
} from '@prisma/client';
import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { ZonedPeriodBranch } from '../../../../shared/time/civil-day';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { Dismissal } from '../closing-queue-rules';

export const CLOSING_QUEUE_REPOSITORY = Symbol('CLOSING_QUEUE_REPOSITORY');
/** Reloj de la lista: «hoy» de cada sede sale de este instante. */
export const CLOSING_QUEUE_NOW = Symbol('CLOSING_QUEUE_NOW');

export interface ClosingLocation {
  id: string;
  name: string;
  timeZone: string | null;
}

/** Qué citas mira una lectura: la ventana por zona y, opcionalmente, quién. */
export interface ClosingScope {
  branches: readonly ZonedPeriodBranch[];
  professionalId?: string;
  /** Solo esta cita (comprobar que un pendiente sigue pendiente). */
  appointmentId?: string;
  /** Solo este ítem (sección TREATMENT). */
  planItemId?: string;
}

/**
 * Una cita de la lista: solo lo que hace falta para cerrarla — paciente,
 * hora, sede y profesional. Ni notas ni motivo ni datos clínicos.
 */
export interface ClosingAppointmentRow {
  appointmentId: string;
  patientId: string;
  patientName: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  locationId: string;
  locationName: string;
  timeZone: string;
  professionalId: string;
  professionalName: string | null;
}

/** Un ítem del plan ligado a la cita y sin marcar como hecho. */
export interface ClosingTreatmentRow extends ClosingAppointmentRow {
  planId: string;
  planItemId: string;
  procedureCode: string;
  procedureLabel: string;
  toothNumber: string;
  surfaces: ToothSurface[];
}

export interface SectionPage<T> {
  rows: T[];
  total: number;
}

export interface ClosingAppointmentRef {
  id: string;
  patientId: string;
  locationId: string;
  providerId: string;
}

export interface DismissalRecord extends Dismissal {
  patientId: string;
  locationId: string;
}

export interface ClosingQueueRepository {
  /** Sedes vivas de la clínica (o solo las permitidas), con su zona. */
  listLocations(allowed: AllowedLocations): Promise<ClosingLocation[]>;
  outcome(
    scope: ClosingScope,
    limit: number,
  ): Promise<SectionPage<ClosingAppointmentRow>>;
  evolution(
    scope: ClosingScope,
    limit: number,
  ): Promise<SectionPage<ClosingAppointmentRow>>;
  treatment(
    scope: ClosingScope,
    limit: number,
  ): Promise<SectionPage<ClosingTreatmentRow>>;
  /** Citas de días anteriores que siguen «en la clínica» (las cierra DX-237). */
  staleInClinic(scope: ClosingScope): Promise<number>;
  findAppointment(id: string): Promise<ClosingAppointmentRef | null>;
  /**
   * Guarda el descarte y su `audit_event` en UNA transacción. Lanza
   * `DismissalExistsError` si ese pendiente ya estaba descartado.
   */
  createDismissal(
    record: DismissalRecord,
    ctx: AuditRequestContext,
  ): Promise<{ id: string; createdAt: Date }>;
}

/** Ya había un descarte de ese pendiente (índice único). */
export class DismissalExistsError extends Error {
  constructor() {
    super('closing queue dismissal already exists');
  }
}

export type { ClosingQueueSection };
