import type {
  AsaClass,
  SedationAgentKind,
  SedationDoseUnit,
  SedationGrade,
  SedationLevel,
  SedationRoute,
  SedationVitalsPhase,
} from '@prisma/client';
import type { SedationSheet } from '../entities';
import type {
  SedationChecklistItem,
  SedationDischargeCriterion,
} from '../sedation-rules';

export const SEDATION_REPOSITORY = Symbol('SEDATION_REPOSITORY');

/** La evolución a la que pertenece la hoja (bajo RLS). */
export interface SedationEntryRef {
  id: string;
  /** Sede de la atención (null en evoluciones legacy). */
  locationId: string | null;
}

/** Valoración previa ya validada; tenant, id y `createdAt` los pone la BD. */
export interface NewSedationRecord {
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
  authorId: string;
}

export interface NewSedationVitals {
  phase: SedationVitalsPhase;
  takenAt: Date;
  spo2: number | null;
  heartRate: number | null;
  systolic: number | null;
  diastolic: number | null;
  respiratoryRate: number | null;
  etco2: number | null;
  sedationLevel: SedationLevel | null;
  authorId: string;
}

export interface NewSedationAgent {
  kind: SedationAgentKind;
  drugName: string | null;
  dose: number | null;
  doseUnit: SedationDoseUnit | null;
  route: SedationRoute;
  n2oPercent: number | null;
  flowLpm: number | null;
  administeredAt: Date;
  authorId: string;
}

export interface NewSedationDischarge {
  criteria: SedationDischargeCriterion[];
  aldreteScore: number | null;
  dischargedAt: Date;
  handedOverToName: string;
  handedOverToRelationship: string;
  instructionsDelivered: boolean;
  operatorId: string;
  monitorId: string;
  sameMonitorJustification: string | null;
}

/** Una parte nueva de la hoja (append-only). */
export type SedationAppend =
  | { kind: 'CHECKLIST'; items: SedationChecklistItem[]; authorId: string }
  | { kind: 'AGENT'; agent: NewSedationAgent }
  | { kind: 'VITALS'; vitals: NewSedationVitals }
  /** Las constantes al alta y el egreso, en la misma transacción. */
  | {
      kind: 'DISCHARGE';
      vitals: NewSedationVitals;
      discharge: NewSedationDischarge;
    };

export interface SedationRepository {
  /** false si el paciente no es de esta clínica (o no existe). */
  patientExists(patientId: string): Promise<boolean>;
  /** Evolución viva de ESTE paciente en esta clínica, o null. */
  findEntry(
    patientId: string,
    entryId: string,
  ): Promise<SedationEntryRef | null>;
  findSheet(patientId: string, entryId: string): Promise<SedationSheet | null>;
  listByPatient(patientId: string): Promise<SedationSheet[]>;
  /** Miembro vigente de esta clínica con rol clínico (ADMIN, DENTIST, ASSISTANT). */
  isClinicalMember(userId: string): Promise<boolean>;
  /** Consentimiento firmado de ESTE paciente en esta clínica. */
  consentExists(patientId: string, consentId: string): Promise<boolean>;
  /**
   * Abre la hoja. Bloquea la evolución (FOR UPDATE) para que dos altas
   * simultáneas no abran dos hojas; `DUPLICATE` si ya tiene una.
   */
  createRecord(input: NewSedationRecord): Promise<SedationSheet | 'DUPLICATE'>;
  /**
   * Append-only. Bloquea la hoja (FOR UPDATE), la relee y llama a `build`,
   * que decide (o lanza) con su estado; inserta lo que devuelva en la MISMA
   * transacción y devuelve la hoja releída. null si la evolución no tiene
   * hoja.
   */
  append(
    patientId: string,
    entryId: string,
    build: (sheet: SedationSheet) => SedationAppend | Promise<SedationAppend>,
  ): Promise<SedationSheet | null>;
}
