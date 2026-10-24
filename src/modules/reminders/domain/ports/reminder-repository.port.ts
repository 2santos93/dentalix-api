import type {
  AppointmentReminderSkipReason,
  AppointmentReminderStatus,
  AppointmentStatus,
  ClinicCountry,
  Prisma,
} from '@prisma/client';
import type { ReminderSettingsInput } from '../reminder-lead-hours';
import type { ReminderRecord } from '../reminder-timeline';
import type { ReminderContact } from '../reminder-eligibility';
import type {
  NoticePatientFields,
  NoticeResponsible,
} from '../../../patients/domain/communication/notice-recipient';

// Sin `tenantId` en ningún input salvo el barrido, que corre como trabajo de
// PLATAFORMA y recorre las clínicas: el tenant sale SIEMPRE del contexto
// (petición o trabajo de la cola) y todo se lee bajo RLS.

export interface LocationReminderSettingsView {
  locationId: string;
  locationName: string;
  enabled: boolean;
  leadHours: number[];
  /** null = la sede nunca se configuró (desactivada por defecto). */
  updatedAt: Date | null;
}

export interface ReminderCandidate {
  appointmentId: string;
  leadHours: number;
  start: Date;
}

/** Lo que el handler relee de la cita al ejecutarse, bajo el tenant del trabajo. */
export interface ReminderSendContext {
  appointment: {
    id: string;
    start: Date;
    status: AppointmentStatus;
    deleted: boolean;
  };
  locationCountry: ClinicCountry;
  locationTimeZone: string;
  patientId: string;
  /** Canal, baja y email VIGENTES del paciente (DX-128). */
  contact: ReminderContact;
  /** Para decidir a quién va y a quién se saluda (DX-128, DX-203). */
  recipient: NoticePatientFields;
  /** DX-203: responsables vivos del paciente (un menor o sin email: a ellos). */
  responsibles: NoticeResponsible[];
  settings: { enabled: boolean; leadHours: number[] } | null;
}

export interface ReminderClaim {
  id: string;
  status: AppointmentReminderStatus;
  outboundMessageId: string | null;
}

export interface AppointmentRemindersSnapshot {
  appointment: { start: Date; status: AppointmentStatus; deleted: boolean };
  /** Sede de la cita: la restricción por sedes (DX-089) se comprueba con ella. */
  locationId: string;
  settings: { enabled: boolean; leadHours: number[] } | null;
  /** Preferencia vigente del paciente de la cita (DX-128). */
  contact: ReminderContact;
  records: ReminderRecord[];
}

export const REMINDER_REPOSITORY = Symbol('REMINDER_REPOSITORY');

export interface ReminderRepository {
  /** Sedes vivas de la clínica en contexto con sus ajustes (o los por defecto). */
  listSettings(): Promise<LocationReminderSettingsView[]>;
  /** null si la sede no existe en esta clínica (o está retirada). */
  saveSettings(
    locationId: string,
    input: ReminderSettingsInput,
    updatedById?: string,
  ): Promise<LocationReminderSettingsView | null>;

  /** Clínicas vivas (para el barrido; `tenants` no tiene RLS). */
  tenantIds(): Promise<string[]>;
  /**
   * Citas de las sedes con recordatorios activos cuya hora toca en la ventana
   * del barrido. Sin las de pacientes con baja o con canal distinto de EMAIL
   * (DX-128): esos no entran en la cola.
   */
  dueCandidates(tenantId: string, now: Date): Promise<ReminderCandidate[]>;

  /** null si la cita no existe en la clínica del contexto. */
  loadSendContext(appointmentId: string): Promise<ReminderSendContext | null>;
  /**
   * Registra la omisión. false si ya había un registro terminado para esa
   * (cita, antelación, hora de inicio).
   */
  recordSkipped(
    appointmentId: string,
    leadHours: number,
    start: Date,
    reason: AppointmentReminderSkipReason,
  ): Promise<boolean>;
  /** Reclama el envío (fila SENDING) o devuelve la que ya existía. */
  claim(
    appointmentId: string,
    leadHours: number,
    start: Date,
  ): Promise<ReminderClaim>;
  /** tx explícita permite crear y asociar el outbound en un único commit. */
  attachOutbound(
    reminderId: string,
    outboundMessageId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void>;
  /** ¿Ya hay un email en email_outbox para ese mensaje? */
  emailQueuedFor(outboundMessageId: string): Promise<boolean>;
  markSent(reminderId: string, sentAt: Date): Promise<void>;
  /** Último fallo: cierra SENDING y su outbound juntos; recupera SENT si ya hay outbox. */
  markFailed(
    appointmentId: string,
    leadHours: number,
    start: Date,
    errorCode: string,
    now: Date,
  ): Promise<void>;

  /** null si la cita no existe (o está retirada) en la clínica del contexto. */
  findAppointmentReminders(
    appointmentId: string,
  ): Promise<AppointmentRemindersSnapshot | null>;
}
