import {
  AppointmentConfirmationResponse,
  AppointmentStatus,
} from '@prisma/client';
import {
  AppointmentConfirmation,
  ClinicBranding,
  ConfirmationAppointment,
} from '../entities/appointment-confirmation.entity';

// Sin `tenantId` en ningún input: el tenant sale SIEMPRE del contexto del
// request (JWT + host en la ruta autenticada, solo host en la pública), igual
// que el resto de repositorios.

export interface IssueConfirmationInput {
  appointmentId: string;
  tokenHash: string;
  expiresAt: Date;
  appointmentStart: Date;
  appointmentStatus: AppointmentStatus;
  createdById?: string;
  /** true = no limpiar `callbackRequestedAt` (enlace del recordatorio automático). */
  keepCallbackRequest: boolean;
  /** false = el automático conserva los enlaces ya enviados. Default: true. */
  revokePrevious?: boolean;
  now: Date;
}

export interface RespondConfirmationInput {
  confirmationId: string;
  appointmentId: string;
  response: AppointmentConfirmationResponse;
  now: Date;
  /** La cita solo se toca si sigue como al emitir el enlace. */
  expectedStart: Date;
  expectedStatus: AppointmentStatus;
}

/**
 * - OK: respuesta registrada y cita actualizada, todo en una transacción.
 * - ALREADY_USED: otro clic ganó la carrera (el enlace es de un solo uso).
 * - STALE: la cita cambió entre la lectura y la escritura; no se tocó nada.
 */
export type RespondOutcome = 'OK' | 'ALREADY_USED' | 'STALE';

export interface ConfirmationLookup {
  confirmation: AppointmentConfirmation;
  /** `null` si la cita se borró (en blando). */
  appointment: ConfirmationAppointment | null;
}

export const APPOINTMENT_CONFIRMATION_REPOSITORY = Symbol(
  'APPOINTMENT_CONFIRMATION_REPOSITORY',
);

export interface AppointmentConfirmationRepository {
  /** Cita viva del tenant en contexto, o `null` (no existe / otra clínica / borrada). */
  findAppointment(
    appointmentId: string,
  ): Promise<ConfirmationAppointment | null>;

  /**
   * En una transacción: conserva o revoca los enlaces pendientes según
   * revokePrevious, crea el nuevo y marca `appointments.confirmationSentAt`.
   */
  issue(input: IssueConfirmationInput): Promise<void>;

  findByTokenHash(tokenHash: string): Promise<ConfirmationLookup | null>;

  findClinicBranding(): Promise<ClinicBranding | null>;

  respond(input: RespondConfirmationInput): Promise<RespondOutcome>;
}
