export type AllergyType = 'MEDICAMENTO' | 'MATERIAL' | 'ALIMENTO' | 'AMBIENTAL';
export type AllergySeverity = 'LEVE' | 'MODERADA' | 'ANAFILAXIA';
export type ConditionStatus = 'SI' | 'NO' | 'DESCONOCE';

export interface Allergy {
  alergeno: string;
  tipo: AllergyType;
  reaccion?: string;
  severidad: AllergySeverity;
  esAlerta: boolean;
}
export interface Condition {
  codigo: string;
  etiqueta: string;
  estado: ConditionStatus;
  esAlerta: boolean;
  nota?: string;
}
export interface Medication {
  nombre: string;
  dosis?: string;
  frecuencia?: string;
  motivo?: string;
  esAlerta: boolean;
}
export interface Habits {
  tabaquismo?: { activo: boolean; porDia?: number; anios?: number };
  alcohol?: { activo: boolean; frecuencia?: string };
  sustancias?: boolean;
  bruxismo?: boolean;
  higieneOral?: {
    cepilladoPorDia?: number;
    hilo?: boolean;
    enjuague?: boolean;
    cremaConFluor?: boolean;
  };
  dieta?: string;
}
export interface DentalHistory {
  motivoConsulta?: string;
  ultimaVisita?: string;
  tratamientosPrevios?: string[];
  malasExperiencias?: string;
  sangradoEncias?: boolean;
  sensibilidad?: boolean;
  atm?: boolean;
  ortodonciaPrevia?: boolean;
  enfPeriodontal?: boolean;
}
export interface Surgery {
  descripcion: string;
  fecha?: string;
}
export interface VitalSigns {
  sistolica?: number;
  diastolica?: number;
  fc?: number;
  fr?: number;
  temp?: number;
  spo2?: number;
  peso?: number;
  talla?: number;
  glucometria?: number;
}
export interface SafetyFlags {
  embarazo: boolean;
  semanasEmbarazo?: number;
  anticoagulantes: boolean;
  bifosfonatos: boolean;
  diabetes: boolean;
  profilaxisAntibiotica: boolean;
  alergiaAnestesico: boolean;
  alergiaPenicilina: boolean;
  alergiaLatex: boolean;
}

/**
 * API-facing shape of a MedicalHistoryVersion (one anamnesis snapshot).
 * APPEND-ONLY: never updated. "Current" = highest `version` for a patient.
 * `safetyFlags`/`hasCriticalAlert` are DERIVED server-side (deriveSafetyFlags),
 * never taken from the client.
 */
export interface MedicalHistory {
  id: string;
  tenantId: string;
  patientId: string;
  version: number;
  allergies: Allergy[];
  conditions: Condition[];
  medications: Medication[];
  habits: Habits | null;
  dentalHistory: DentalHistory | null;
  surgeries: Surgery[];
  vitalSigns: VitalSigns | null;
  familyHistory: string | null;
  notes: string | null;
  safetyFlags: SafetyFlags;
  hasCriticalAlert: boolean;
  createdById: string | null;
  createdAt: Date;
}
