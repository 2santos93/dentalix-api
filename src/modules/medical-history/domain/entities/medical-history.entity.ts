export type AllergyType = 'MEDICAMENTO' | 'MATERIAL' | 'ALIMENTO' | 'AMBIENTAL';
export type AllergySeverity = 'LEVE' | 'MODERADA' | 'ANAFILAXIA';
export type ConditionStatus = 'SI' | 'NO' | 'DESCONOCE';
/**
 * DX-099: de dónde salió una versión: tecleada por el personal (STAFF) o
 * aceptada por un profesional desde el formulario que llenó el paciente por
 * enlace (PATIENT_FORM; el autor es quien la revisó).
 */
export type MedicalHistorySource = 'STAFF' | 'PATIENT_FORM';

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
/**
 * Respuesta tri-estado de la anamnesis, como las condiciones: Sí / No / No
 * sabe. La AUSENCIA es «Sin responder» (nunca se lee como «No»).
 */
export type AnswerStatus = ConditionStatus;

/**
 * Hábitos (forma tri-estado). Cada pregunta es `AnswerStatus` y ausente =
 * «Sin responder». Las versiones guardadas antes de esta forma tienen
 * booleanos (`tabaquismo.activo`, `bruxismo: true`…): NO se reescriben
 * (append-only); se LEEN con `readStoredHabits` (true → «Sí», false → «No»,
 * ausente → sin responder), que es exactamente lo que registraron.
 */
export interface Habits {
  tabaquismo?: { estado: AnswerStatus; porDia?: number; anios?: number };
  alcohol?: { estado: AnswerStatus; frecuencia?: string };
  sustancias?: AnswerStatus;
  bruxismo?: AnswerStatus;
  higieneOral?: {
    cepilladoPorDia?: number;
    hilo?: AnswerStatus;
    enjuague?: AnswerStatus;
    cremaConFluor?: AnswerStatus;
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
  /**
   * Embarazo tri-estado; `null` = sin responder. Versiones anteriores a la
   * columna: «Sí» si `safetyFlags.embarazo`, si no `null` (entonces solo se
   * guardaba el «Sí»: un «No» y una pregunta no hecha eran iguales).
   */
  pregnancy: AnswerStatus | null;
  dentalHistory: DentalHistory | null;
  surgeries: Surgery[];
  vitalSigns: VitalSigns | null;
  familyHistory: string | null;
  notes: string | null;
  safetyFlags: SafetyFlags;
  hasCriticalAlert: boolean;
  source: MedicalHistorySource;
  createdById: string | null;
  createdAt: Date;
}
