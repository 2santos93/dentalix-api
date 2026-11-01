import type {
  RecallContactChannel,
  RecallContactOutcome,
  RecallKind,
} from '@prisma/client';
import type { RecallStatus } from './recall-rules';

/** Tope de la nota de un contacto (CHECK en la BD). */
export const RECALL_NOTE_MAX = 280;
/** Tope del motivo de desactivación (CHECK en la BD). */
export const RECALL_DISABLED_REASON_MAX = 120;

export const RECALL_DEFAULT_PAGE_SIZE = 20;
export const RECALL_MAX_PAGE_SIZE = 100;

/** Orden de la lista: por días de vencido. */
export type RecallDueSort = 'MOST_OVERDUE' | 'LEAST_OVERDUE';

export interface RecallDueQuery {
  kind?: RecallKind;
  withinDays: number;
  sort: RecallDueSort;
  page: number;
  pageSize: number;
  now: Date;
}

/** El último contacto del recall (lo usará DX-465 para ocultar N días). */
export interface RecallLastContact {
  channel: RecallContactChannel;
  outcome: RecallContactOutcome;
  createdAt: Date;
}

/** Una fila de la lista de llamada. */
export interface RecallDueRow {
  recallId: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string | null;
  /** Región telefónica por defecto de la sede del paciente (lectura de wa.me). */
  phoneRegion: string | null;
  reminderOptedOut: boolean;
  kind: RecallKind;
  intervalMonths: number;
  /** Base del vencimiento (lo fijado o la última visita atendida). */
  baseDate: string;
  dueAt: string;
  daysOverdue: number;
  /** Sede del paciente: la de su última cita atendida o, sin ella, la del recall. */
  locationId: string;
  lastContact: RecallLastContact | null;
}

export interface RecallDueItem {
  recallId: string;
  patientId: string;
  patientName: string;
  patientPhone: string | null;
  /** E.164 sin `+` para `https://wa.me/…`; null si no sirve o hay baja de avisos. */
  patientWhatsApp: string | null;
  /** DX-128: baja de los avisos. Sigue en la lista, pero sin «Llamar»/«WhatsApp». */
  reminderOptedOut: boolean;
  kind: RecallKind;
  intervalMonths: number;
  baseDate: string;
  dueAt: string;
  daysOverdue: number;
  locationId: string;
  lastContact: RecallLastContact | null;
}

export interface RecallDuePage {
  items: RecallDueItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** Hechos de un recall del paciente leídos de la BD (ficha). */
export interface PatientRecallRow {
  id: string;
  kind: RecallKind;
  intervalMonths: number;
  lastDoneAt: string;
  active: boolean;
  disabledUntil: string | null;
  disabledReason: string | null;
  locationId: string;
  lastCompletedVisit: string | null;
  hasUpcomingAppointment: boolean;
  /** Hoy en la zona de la sede del paciente. */
  today: string;
  updatedAt: Date;
  updatedById: string;
}

export interface PatientRecallView {
  id: string;
  kind: RecallKind;
  intervalMonths: number;
  lastDoneAt: string;
  active: boolean;
  disabledUntil: string | null;
  disabledReason: string | null;
  locationId: string;
  baseDate: string;
  dueAt: string;
  daysOverdue: number;
  status: RecallStatus;
  updatedAt: Date;
  updatedBy: StaffRef;
}

export interface StaffRef {
  id: string;
  /** `null` si ya no es resoluble (usuario fuera de la clínica). */
  fullName: string | null;
}

export interface RecallContactView {
  id: string;
  recallId: string;
  kind: RecallKind;
  patientId: string;
  locationId: string | null;
  channel: RecallContactChannel;
  outcome: RecallContactOutcome;
  note: string | null;
  appointmentId: string | null;
  author: StaffRef;
  createdAt: Date;
}

export interface PatientRecalls {
  recalls: PatientRecallView[];
  contacts: RecallContactView[];
}

export interface SetPatientRecallData {
  patientId: string;
  kind: RecallKind;
  intervalMonths: number;
  lastDoneAt: string;
  active: boolean;
  disabledUntil: string | null;
  disabledReason: string | null;
  actorId: string;
}

export interface NewRecallContact {
  recallId: string;
  patientId: string;
  locationId: string | null;
  channel: RecallContactChannel;
  outcome: RecallContactOutcome;
  note: string | null;
  appointmentId: string | null;
  authorId: string;
}
