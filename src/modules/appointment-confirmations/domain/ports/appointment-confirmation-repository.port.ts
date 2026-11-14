import {
  AppointmentConfirmationResponse,
  AppointmentStatus,
  type EarlierWindow,
} from '@prisma/client';
import {
  AppointmentConfirmation,
  ClinicBranding,
  ConfirmationAppointment,
} from '../entities/appointment-confirmation.entity';
import type { LinkCancellationPolicy } from '../link-cancellation-policy';
import type {
  AuditRequestContext,
  AuditRequestMeta,
} from '../../../audit/domain/audit-request-context';

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
  /**
   * DX-361: quién lo pide (recepción). Con él, la emisión deja su evento de
   * auditoría en la misma transacción; el recordatorio automático no lo pasa.
   */
  audit?: AuditRequestContext;
}

export interface RespondConfirmationInput {
  confirmationId: string;
  appointmentId: string;
  response: AppointmentConfirmationResponse;
  now: Date;
  /** La cita solo se toca si sigue como al emitir el enlace. */
  expectedStart: Date;
  expectedStatus: AppointmentStatus;
  /** DX-291: el paciente aceptó la política (cancelar tarde lo exige). */
  acknowledgePolicy?: boolean;
  /** DX-291: la versión que le mostró la página (sin enviar: no se compara). */
  shownPolicyVersionId?: string | null;
  /**
   * DX-361: desde dónde respondió el paciente. Una respuesta registrada deja
   * SIEMPRE su evento de auditoría en la misma transacción.
   */
  request?: AuditRequestMeta | null;
}

/**
 * - OK: respuesta registrada y cita actualizada, todo en una transacción.
 * - ALREADY_USED: otro clic ganó la carrera (el enlace es de un solo uso).
 * - STALE: la cita cambió entre la lectura y la escritura; no se tocó nada.
 * - POLICY_CHANGED / ACK_REQUIRED (DX-291): la política vigente no es la que
 *   vio el paciente, o cancela tarde sin aceptarla; no se tocó nada.
 */
export type RespondOutcome =
  'OK' | 'ALREADY_USED' | 'STALE' | 'POLICY_CHANGED' | 'ACK_REQUIRED';

/** DX-437: «Avisarme si se libera un hueco antes» desde el enlace. */
export interface SetWantsEarlierInput {
  appointmentId: string;
  wantsEarlier: boolean;
  /** Solo con `wantsEarlier`; sin franja, ANY. */
  window: EarlierWindow | null;
  now: Date;
  /** La cita solo se toca si sigue agendada o confirmada y en el futuro. */
  request?: AuditRequestMeta | null;
}

/** OK; STALE = la cita ya no admite la marca (cambió bajo nuestros pies). */
export type SetWantsEarlierOutcome = 'OK' | 'STALE';

export interface ConfirmationLookup {
  confirmation: AppointmentConfirmation;
  /** `null` si la cita se borró (en blando). */
  appointment: ConfirmationAppointment | null;
  /** DX-291: política vigente de la sede de la cita (`null` = sin política). */
  policy: LinkCancellationPolicy | null;
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
   * revokePrevious, crea el nuevo, marca `appointments.confirmationSentAt` y,
   * con `audit`, escribe el evento (reenvío si la cita ya tenía uno enviado).
   */
  issue(input: IssueConfirmationInput): Promise<void>;

  findByTokenHash(tokenHash: string): Promise<ConfirmationLookup | null>;

  findClinicBranding(): Promise<ClinicBranding | null>;

  respond(input: RespondConfirmationInput): Promise<RespondOutcome>;

  /**
   * DX-437: en una transacción, con la cita bloqueada: pone o quita la marca
   * (con su franja y «lo pidió el paciente») y escribe el evento de auditoría
   * (origen PUBLIC_LINK). Si la cita ya no está agendada/confirmada o ya pasó,
   * STALE y no se toca nada.
   */
  setWantsEarlier(input: SetWantsEarlierInput): Promise<SetWantsEarlierOutcome>;
}
