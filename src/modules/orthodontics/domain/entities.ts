import type {
  OrthoAlignerArch,
  OrthoCaseStatus,
  OrthoElasticType,
  OrthoElasticWear,
  OrthoIncident,
  OrthoTechnique,
} from '@prisma/client';
import type { OrthoProgress, OrthoWire } from './ortho-rules';
import type { AlignerState } from './ortho-billing';

/** Ajustes de ortodoncia de la clínica (DX-190). */
export interface OrthoSettings {
  enabled: boolean;
  wireGauges: string[];
  /** DX-285: días tras los que un cargo realizado y sin pagar vence (30). */
  overdueDays: number;
}

/** DX-285: honorario del caso y su reparto, en la moneda del caso. */
export interface OrthoFee {
  currency: string;
  total: number;
  initial: number;
  perVisit: number;
  visitCount: number;
  retention: number;
  updatedAt: Date | null;
  updatedById: string | null;
  /** Aceptado = sus cargos están en el plan; desde entonces no cambia. */
  acceptedAt: Date | null;
  acceptedById: string | null;
  /** Cuotas que ya tenía el plan al aceptar: sin cargos, solo se informa. */
  paymentPlanId: string | null;
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
  /** DX-285: null mientras el caso no tenga honorario. */
  fee: OrthoFee | null;
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

// ---------------------------------------------------------------------------
// DX-285: cuenta del caso y alineadores
// ---------------------------------------------------------------------------

/**
 * Cómo se cobra el caso: sin honorario, con honorario aún sin aceptar, con
 * sus cargos en el plan, o con las cuotas que el plan ya tenía (solo se
 * informa, sin cargos).
 */
export type OrthoBilling = 'NONE' | 'PENDING' | 'PLAN_ITEMS' | 'PAYMENT_PLAN';

export interface OrthoAccountPaymentPlan {
  id: string;
  status: string;
  installmentsCount: number;
  totalToFinance: number;
  currency: string;
}

/** GET …/ortho-cases/:caseId/account: lo que se debe del caso. */
export interface OrthoCaseAccount {
  caseId: string;
  patientId: string;
  /** Sede del caso: la de sus fechas e importes. */
  locationId: string;
  status: OrthoCaseStatus;
  startDate: string;
  plannedVisits: number;
  visitsDone: number;
  billing: OrthoBilling;
  currency: string | null;
  treatmentPlanId: string | null;
  fee: OrthoFee | null;
  /** Realizado hasta hoy (cargos hechos), null sin cargos. */
  billed: number | null;
  /** Lo imputado (DX-051) a los cargos del caso. */
  paid: number | null;
  /** Realizado − pagado (negativo = pagado por adelantado). */
  balance: number | null;
  /** Lo que falta por realizar del honorario. */
  remaining: number | null;
  /** Lo realizado y sin pagar de hace más de `overdueDays` días. */
  overdue: number | null;
  overdueSince: string | null;
  overdueAgeDays: number;
  hasOverdue: boolean;
  overdueDays: number;
  /** Controles cuyo cargo ya está realizado. */
  visitsCharged: number;
  /** Cargos cuyo ítem se retiró del plan (no cuentan; la vista lo avisa). */
  removedCharges: number;
  paymentPlan: OrthoAccountPaymentPlan | null;
}

/** Marca «Ortodoncia: saldo vencido» de un paciente (agenda, En clínica). */
export interface OrthoBalanceFlag {
  hasOverdue: boolean;
  /** Días del cargo vencido más antiguo, o null. */
  overdueDays: number | null;
}

export interface OrthoAlignerDeliveryView {
  id: string;
  fromTray: number;
  toTray: number;
  deliveredOn: string;
  visitId: string | null;
  createdById: string;
  createdByName: string | null;
  createdAt: Date;
}

export interface OrthoAlignerSeriesView {
  id: string;
  caseId: string;
  arch: OrthoAlignerArch;
  brand: string;
  totalTrays: number;
  daysPerTray: number;
  refinementOfId: string | null;
  /** 1 = la serie inicial; 2… cada refinamiento encadenado. */
  sequence: number;
  createdById: string;
  createdByName: string | null;
  createdAt: Date;
  deliveries: OrthoAlignerDeliveryView[];
  state: AlignerState;
  currentTray: number | null;
  currentTrayStartedOn: string | null;
  nextChangeOn: string | null;
  lastDeliveredTray: number;
  estimatedEndOn: string | null;
}

/** La serie vigente de cada arcada (la más reciente que la cubre). */
export interface OrthoAlignersView {
  today: string;
  series: OrthoAlignerSeriesView[];
  upperSeriesId: string | null;
  lowerSeriesId: string | null;
}
