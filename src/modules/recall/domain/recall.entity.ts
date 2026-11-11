import type {
  RecallContactChannel,
  RecallContactOutcome,
  RecallKind,
  RecallSource,
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
  /** Compatibilidad (DX-015): el tipo con esa `systemKey`. */
  kind?: RecallKind;
  /** DX-015-bis: solo un tipo de la clínica. */
  recallTypeId?: string;
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
  /** DEPRECADO (D7): la `systemKey` del tipo, o null si no tiene. */
  kind: RecallKind | null;
  recallTypeId: string;
  recallTypeName: string;
  intervalMonths: number;
  /** Base del vencimiento: lo fijado o el último DONE de un disparador. */
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
  kind: RecallKind | null;
  recallTypeId: string;
  recallTypeName: string;
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
  kind: RecallKind | null;
  recallTypeId: string;
  recallTypeName: string;
  intervalMonths: number;
  lastDoneAt: string;
  /** Vencimiento guardado (columna generada). */
  dueAt: string;
  manualDoneAt: string | null;
  lastDoneItemId: string | null;
  source: RecallSource;
  /** Lo fijado antes del relleno, si la base congelada lo movió. */
  preBackfillDoneAt: string | null;
  active: boolean;
  disabledUntil: string | null;
  disabledReason: string | null;
  locationId: string;
  hasUpcomingAppointment: boolean;
  /** Hoy en la zona de la sede del paciente. */
  today: string;
  updatedAt: Date;
  updatedById: string;
}

export interface PatientRecallView {
  id: string;
  kind: RecallKind | null;
  recallTypeId: string;
  recallTypeName: string;
  intervalMonths: number;
  lastDoneAt: string;
  manualDoneAt: string | null;
  lastDoneItemId: string | null;
  source: RecallSource;
  preBackfillDoneAt: string | null;
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

/** Un recall con su sede (la de la última cita atendida o, sin ella, la del recall). */
export interface RecallRef {
  id: string;
  patientId: string;
  kind: RecallKind | null;
  locationId: string;
}

export interface StaffRef {
  id: string;
  /** `null` si ya no es resoluble (usuario fuera de la clínica). */
  fullName: string | null;
}

export interface RecallContactView {
  id: string;
  recallId: string;
  kind: RecallKind | null;
  recallTypeId: string;
  recallTypeName: string;
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
  recallType: RecallTypeRef;
  intervalMonths: number;
  /**
   * Lo que fija el clínico (`manualDoneAt`); la base es el máximo con los DONE.
   * `undefined` = no se fijó fecha: un recall que ya existe conserva lo que
   * tenía ("manualDoneAt", también null, "preBackfillDoneAt" y la base), y uno
   * nuevo nace con `newRecallDoneAt`.
   */
  manualDoneAt: string | undefined;
  /** El día de hoy en la sede de trabajo: la fecha de un alta sin fecha. */
  newRecallDoneAt: string;
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

/** DX-015-bis: lo justo de un tipo para fijar un recall. */
export interface RecallTypeRef {
  id: string;
  systemKey: RecallKind | null;
}

/** DX-015-bis: un tipo de recall de la clínica (`GET /recall-types`). */
export interface RecallTypeView {
  id: string;
  name: string;
  defaultIntervalMonths: number;
  active: boolean;
  sortOrder: number;
  systemKey: RecallKind | null;
  exclusionGroup: string | null;
  /** Procedimientos del catálogo cuyo DONE mueve el reloj del tipo. */
  triggerCatalogItemIds: string[];
}
