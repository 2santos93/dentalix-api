import type {
  OrthoCaseStatus,
  OrthoElasticType,
  OrthoElasticWear,
  OrthoIncident,
  OrthoTechnique,
} from '@prisma/client';
import type { OrthoProgress, OrthoWire } from './ortho-rules';

/** Ajustes de ortodoncia de la clínica (DX-190). */
export interface OrthoSettings {
  enabled: boolean;
  wireGauges: string[];
}

/** El caso tal como está guardado (fechas civiles `YYYY-MM-DD`). */
export interface OrthoCaseRecord {
  id: string;
  patientId: string;
  locationId: string;
  providerId: string;
  treatmentPlanId: string | null;
  technique: OrthoTechnique;
  startDate: string;
  estimatedMonths: number;
  plannedVisits: number;
  visitIntervalDays: number;
  status: OrthoCaseStatus;
  statusReason: string | null;
  statusChangedAt: Date | null;
  statusChangedById: string | null;
  bondedOn: string | null;
  debondedOn: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Lo que la ficha muestra de un caso: cabecera, progreso y arco actual. */
export interface OrthoCaseView extends OrthoCaseRecord {
  locationName: string;
  providerName: string | null;
  statusChangedByName: string | null;
  progress: OrthoProgress;
  /** El de cada arcada en su último control que lo registró. */
  currentUpperWire: OrthoWire | null;
  currentLowerWire: OrthoWire | null;
  lastVisitDate: string | null;
  /** El próximo control que propuso el último control. */
  nextVisitProposedOn: string | null;
  /** Solo en un caso ACTIVE: último control hace más de intervalo + 15 días. */
  overdue: boolean;
}

export interface OrthoVisitAddendum {
  id: string;
  reason: string | null;
  text: string;
  authorId: string;
  authorName: string | null;
  createdAt: Date;
}

/** Un control con su evolución y las adendas que lo corrigen. */
export interface OrthoVisitView {
  id: string;
  caseId: string;
  clinicalEntryId: string;
  /** Orden del control en el caso (1 = el primero). */
  visitNumber: number;
  visitDate: string;
  appointmentId: string | null;
  upperWire: OrthoWire | null;
  lowerWire: OrthoWire | null;
  elasticsType: OrthoElasticType | null;
  elasticsWear: OrthoElasticWear | null;
  applianceChanges: string | null;
  incidents: OrthoIncident[];
  hygieneIndex: number | null;
  nextVisitProposedOn: string | null;
  /** Texto de la evolución (lo que ve la historia clínica general). */
  notes: string;
  authorId: string;
  authorName: string | null;
  createdAt: Date;
  addenda: OrthoVisitAddendum[];
}

/** Fila de la lista de la clínica (Pacientes › Ortodoncia). */
export interface OrthoFollowUpRow {
  caseId: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string | null;
  /** E.164 con «+» del teléfono (para wa.me), o null. */
  patientPhoneE164: string | null;
  locationId: string;
  locationName: string;
  providerId: string;
  providerName: string | null;
  technique: OrthoTechnique;
  startDate: string;
  visitIntervalDays: number;
  visitsDone: number;
  plannedVisits: number;
  lastVisitDate: string | null;
  daysSinceLastVisit: number;
  overdue: boolean;
  nextAppointmentAt: Date | null;
  noNextAppointment: boolean;
  /** Citas del paciente marcadas «No asistió» desde el inicio del caso. */
  noShowCount: number;
}

export type OrthoFollowUpFilter = 'ALL' | 'OVERDUE' | 'NO_NEXT_APPOINTMENT';

export interface OrthoFollowUpPage {
  items: OrthoFollowUpRow[];
  total: number;
  page: number;
  pageSize: number;
}
