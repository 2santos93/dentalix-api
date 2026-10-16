import type {
  AppointmentStatus,
  WaitlistPriority,
  WaitlistStatus,
} from '@prisma/client';
import type { AppointmentTypeSummary } from '../../../appointment-types/domain/entities/appointment-type.entity';

/**
 * Entrada de «Pendientes por agendar» (DX-122): un paciente al que hay que
 * volver a llamar para darle cita. Nace OPEN —sola, al cancelar o marcar
 * no-show una cita, o a mano— y se cierra agendando (SCHEDULED, con la cita
 * nueva) o descartando con motivo (DISMISSED).
 */
export interface WaitlistEntry {
  id: string;
  tenantId: string;
  locationId: string;
  patientId: string;
  /** Nombre y teléfono para llamar sin abrir la ficha. */
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string | null;
  /** La cita cancelada o no-show que la originó (null en un alta manual). */
  sourceAppointmentId: string | null;
  sourceAppointment: {
    start: Date;
    end: Date;
    status: AppointmentStatus;
  } | null;
  providerId: string | null;
  appointmentTypeId: string | null;
  appointmentType: AppointmentTypeSummary | null;
  /** Duración de la cita a buscar. */
  durationMinutes: number;
  priority: WaitlistPriority;
  preferredWindow: string | null;
  note: string | null;
  status: WaitlistStatus;
  resolvedAppointmentId: string | null;
  dismissReason: string | null;
  createdById: string | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WaitlistPage {
  items: WaitlistEntry[];
  total: number;
  page: number;
  pageSize: number;
}
