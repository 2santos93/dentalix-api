import type {
  ClinicCountry,
  ContactChannel,
  ReminderOptOutSource,
  WhatsappOptInSource,
} from '@prisma/client';

import type { NoticeResponsible } from '../communication/notice-recipient';

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
  /** DX-203: país y zona de la sede con que se cuenta la edad. */
  noticeLocation: { country: ClinicCountry; timeZone: string };
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

export const PATIENT_COMMUNICATION_REPOSITORY = Symbol(
  'PATIENT_COMMUNICATION_REPOSITORY',
);

// Sin tenantId: sale del contexto de la petición y todo va bajo RLS.
export interface PatientCommunicationRepository {
  /** null si el paciente no existe (o no es de esta clínica, o se retiró). */
  find(patientId: string): Promise<PatientCommunicationState | null>;
  /**
   * País (ClinicCountry) con el que se valida el móvil: el de la sede activa
   * de la petición (X-Location-Id) o, en la vista consolidada, el de la sede
   * principal (la viva más antigua). null si la clínica no tiene sedes.
   */
  locationCountry(): Promise<string | null>;
  /** Canal con el que nacen los pacientes de la clínica. */
  clinicDefaultChannel(): Promise<ContactChannel>;
  /** Aplica el cambio y devuelve el estado nuevo (404 si ya no existe). */
  update(
    patientId: string,
    patch: PatientCommunicationPatch,
    invalidateOptOutLinksAt?: Date,
  ): Promise<PatientCommunicationState>;
}
