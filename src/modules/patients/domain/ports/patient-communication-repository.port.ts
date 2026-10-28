import type {
  ContactChannel,
  ReminderOptOutSource,
  WhatsappOptInSource,
} from '@prisma/client';

import type {
  NoticeResponsible,
  NoticeSettings,
} from '../communication/notice-recipient';

export const PATIENT_NOT_FOUND_MESSAGE = 'Paciente no encontrado';

/** Bloque «Comunicaciones» de la ficha (DX-128), tal como está guardado. */
export interface PatientCommunicationState {
  patientId: string;
  /** Para saber a quién se dirigen los avisos (un menor: su responsable). */
  firstName: string;
  birthDate: Date | null;
  emergencyContactName: string | null;
  /** DX-203: responsables vivos del paciente (regla de destinatario). */
  responsibles: NoticeResponsible[];
  /** DX-203, DX-328: zona de la sede y mayoría de edad de la clínica. */
  noticeSettings: NoticeSettings;
  /** País de residencia del paciente (respaldo si la clínica no tiene sede). */
  countryCode: string | null;
  phone: string | null;
  email: string | null;
  contactChannel: ContactChannel;
  whatsappOptInAt: Date | null;
  whatsappOptInSource: WhatsappOptInSource | null;
  /** Quién registró el opt-in; `fullName` null si ya no es de la clínica. */
  whatsappOptInBy: { id: string; fullName: string | null } | null;
  reminderOptOutAt: Date | null;
  reminderOptOutSource: ReminderOptOutSource | null;
}

/** Columnas que cambia el bloque; ausente = no se toca. */
export interface PatientCommunicationPatch {
  phone?: string | null;
  contactChannel?: ContactChannel;
  whatsappOptInAt?: Date | null;
  whatsappOptInSource?: WhatsappOptInSource | null;
  whatsappOptInById?: string | null;
  reminderOptOutAt?: Date | null;
  reminderOptOutSource?: ReminderOptOutSource | null;
}

/** El plan se evalúa dentro de la TX, sobre la fila del paciente bloqueada. */
export type PatientCommunicationUpdate =
  | PatientCommunicationPatch
  | ((current: PatientCommunicationState) => PatientCommunicationPatch);

export interface PatientCommunicationUpdateResult {
  state: PatientCommunicationState;
  /** Cambios de preferencias efectivos frente al estado protegido por el lock. */
  changedFields: string[];
}

export const PATIENT_COMMUNICATION_REPOSITORY = Symbol(
  'PATIENT_COMMUNICATION_REPOSITORY',
);

// Sin tenantId: sale del contexto de la petición y todo va bajo RLS.
export interface PatientOptOutMatchWarningView {
  id: string;
  createdAt: Date;
  matchCount: number;
  maxMatches: number;
}

export interface PatientCommunicationRepository {
  /** null si el paciente no existe (o no es de esta clínica, o se retiró). */
  find(patientId: string): Promise<PatientCommunicationState | null>;
  /** null: paciente ajeno/retirado; últimos20 avisos de comunicaciones. */
  optOutWarnings(
    patientId: string,
  ): Promise<PatientOptOutMatchWarningView[] | null>;
  /**
   * País (ClinicCountry) con el que se valida el móvil: el de la sede activa
   * de la petición (X-Location-Id) o, en la vista consolidada, el de la sede
   * principal (la viva más antigua). null si la clínica no tiene sedes.
   */
  locationCountry(): Promise<string | null>;
  /** Canal con el que nacen los pacientes de la clínica. */
  clinicDefaultChannel(): Promise<ContactChannel>;
  /** Aplica bajo lock y devuelve estado/diff efectivos (404 si ya no existe). */
  update(
    patientId: string,
    update: PatientCommunicationUpdate,
    invalidateOptOutLinksAt?: Date,
  ): Promise<PatientCommunicationUpdateResult>;
}
