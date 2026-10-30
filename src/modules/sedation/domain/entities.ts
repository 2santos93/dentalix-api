import type {
  AsaClass,
  SedationAgentKind,
  SedationDoseUnit,
  SedationGrade,
  SedationLevel,
  SedationRoute,
  SedationVitalsPhase,
} from '@prisma/client';
import type {
  SedationChecklistItem,
  SedationDischargeCriterion,
} from './sedation-rules';

/** Quién hizo cada parte: usuario y nombre (por la membresía, bajo RLS). */
export interface SedationActor {
  id: string;
  /** null si ya no consta en la clínica. */
  name: string | null;
}

export interface SedationChecklistRow {
  id: string;
  items: SedationChecklistItem[];
  author: SedationActor;
  /** Hora del servidor en que se marcó. */
  checkedAt: Date;
}

export interface SedationAgentRow {
  id: string;
  kind: SedationAgentKind;
  drugName: string | null;
  dose: number | null;
  doseUnit: SedationDoseUnit | null;
  route: SedationRoute;
  n2oPercent: number | null;
  flowLpm: number | null;
  administeredAt: Date;
  author: SedationActor;
  createdAt: Date;
}

export interface SedationVitalsRow {
  id: string;
  phase: SedationVitalsPhase;
  takenAt: Date;
  spo2: number | null;
  heartRate: number | null;
  systolic: number | null;
  diastolic: number | null;
  respiratoryRate: number | null;
  etco2: number | null;
  sedationLevel: SedationLevel | null;
  author: SedationActor;
  createdAt: Date;
}

export interface SedationDischargeRow {
  id: string;
  criteria: SedationDischargeCriterion[];
  aldreteScore: number | null;
  vitalsId: string;
  dischargedAt: Date;
  handedOverToName: string;
  handedOverToRelationship: string;
  instructionsDelivered: boolean;
  operator: SedationActor;
  monitor: SedationActor;
  sameMonitorJustification: string | null;
  createdAt: Date;
}

/**
 * Hoja de sedación de una evolución (DX-407). INALTERABLE como la evolución
 * (DX-038): cada parte es una fila nueva, no hay método para editarla ni
 * borrarla y la BD lo impide; se corrige con una adenda de la evolución.
 */
export interface SedationSheet {
  id: string;
  patientId: string;
  clinicalEntryId: string;
  locationId: string | null;
  templateVersion: string;
  rulesVersion: string;
  vitalsIntervalMinutes: number;
  grade: SedationGrade;
  asaClass: AsaClass | null;
  asaEmergency: boolean;
  highAsaInterconsultation: string | null;
  highAsaJustification: string | null;
  fastingClearLiquidsHours: number | null;
  fastingSolidsHours: number | null;
  mallampati: number | null;
  weightKg: number | null;
  heightCm: number | null;
  bmi: number | null;
  naloxoneMg: number | null;
  flumazenilMg: number | null;
  escortName: string | null;
  escortRelationship: string | null;
  consentConfirmed: boolean;
  consentId: string | null;
  author: SedationActor;
  createdAt: Date;
  checklist: SedationChecklistRow | null;
  /** En orden de administración. */
  agents: SedationAgentRow[];
  /** En orden de toma. */
  vitals: SedationVitalsRow[];
  discharge: SedationDischargeRow | null;
}
