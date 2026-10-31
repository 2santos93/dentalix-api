import type { AppointmentStatus } from '@prisma/client';

export const CONTINGENCY_AGENDA_REPOSITORY = Symbol(
  'CONTINGENCY_AGENDA_REPOSITORY',
);
/** Reloj de la agenda de contingencia (inyectable en las pruebas). */
export const CONTINGENCY_AGENDA_CLOCK = Symbol('CONTINGENCY_AGENDA_CLOCK');
export type ContingencyClock = () => Date;

/** La sede (viva y activa) con lo que hace falta para pintar su agenda. */
export interface ContingencyLocation {
  id: string;
  tenantId: string;
  name: string;
  phone: string | null;
  timeZone: string | null;
  locale: string | null;
  hourCycle: string | null;
  /** DX-329: región con la que se leen los teléfonos escritos sin «+». */
  defaultPhoneRegion: string | null;
  clinicName: string;
}

/** Una cita de la ventana, tal cual de la BD (sin notas ni motivo). */
export interface ContingencyAppointmentRow {
  appointmentId: string;
  patientId: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  firstName: string;
  lastName: string;
  phone: string | null;
  professionalName: string | null;
  appointmentTypeName: string | null;
  firstVisit: boolean;
  callbackRequested: boolean;
}

/** La última copia nocturna de una sede. */
export interface ContingencySnapshot {
  locationId: string;
  /** «Hoy» (YYYY-MM-DD) en la zona de la sede al generarla. */
  forDate: string;
  generatedAt: Date;
  appointmentCount: number;
  sizeBytes: number;
  storageKey: string;
}

/** Una sede que el barrido nocturno puede generar (zona y formato configurados). */
export interface NightlyCandidate {
  locationId: string;
  timeZone: string;
  /** Día que cubre la copia vigente, o null si aún no tiene. */
  lastForDate: string | null;
}

/**
 * Lecturas y escrituras de la agenda de contingencia (DX-339). Todo bajo RLS
 * con la clínica del contexto (petición o trabajo) y `tenantId` explícito.
 */
export interface ContingencyAgendaRepository {
  /** La sede viva y activa de la clínica del contexto, o null. */
  findLocation(locationId: string): Promise<ContingencyLocation | null>;
  /** Citas vivas de la sede con inicio en `[from, to)`, salvo canceladas e inasistencias. */
  listAppointments(
    locationId: string,
    from: Date,
    to: Date,
  ): Promise<ContingencyAppointmentRow[]>;
  findSnapshot(locationId: string): Promise<ContingencySnapshot | null>;
  /** Crea o sobrescribe la copia de la sede. */
  saveSnapshot(snapshot: ContingencySnapshot): Promise<void>;
  /** Clínicas vivas (para el barrido). */
  tenantIds(): Promise<string[]>;
  /** Sedes vivas y activas de `tenantId` con zona, formato y reloj. */
  nightlyCandidates(tenantId: string): Promise<NightlyCandidate[]>;
}
