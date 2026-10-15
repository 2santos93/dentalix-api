import {
  AppointmentConfirmationResponse,
  AppointmentStatus,
} from '@prisma/client';

/**
 * Estado público de un enlace de confirmación (ver `confirmationState`):
 * - PENDING: el paciente todavía puede responder.
 * - RESPONDED: ya respondió; el enlace solo muestra la respuesta dada.
 * - EXPIRED: caducado o sin efecto (llegó la cita, se emitió otro enlace, o la
 *   cita se reagendó / cambió de estado / ya no existe).
 */
export type ConfirmationState = 'PENDING' | 'RESPONDED' | 'EXPIRED';

/** Fila del enlace, sin el hash del token (nunca sale del repositorio). */
export interface AppointmentConfirmation {
  id: string;
  appointmentId: string;
  expiresAt: Date;
  /** Foto de la cita al emitir el enlace: si cambia, el enlace deja de valer. */
  appointmentStart: Date;
  appointmentStatus: AppointmentStatus;
  respondedAt: Date | null;
  response: AppointmentConfirmationResponse | null;
  revokedAt: Date | null;
}

/**
 * Lo que el flujo de confirmación necesita de una cita: lo mínimo para el
 * mensaje y la página pública (nada clínico: ni motivo ni notas).
 */
export interface ConfirmationAppointment {
  id: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  patientFirstName: string | null;
  patientPhone: string | null;
  patientCountryCode: string | null;
  providerName: string | null;
  locationName: string;
  locationAddress: string | null;
}

export interface ClinicBranding {
  name: string;
  primaryColor: string;
  logoUrl: string | null;
}
