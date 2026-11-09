import type { HourCycle } from '../../../shared/format/regional-format';
import {
  AppointmentConfirmationResponse,
  type EarlierWindow,
} from '@prisma/client';
import { civilDateIn } from '../../../shared/time/civil-day';
import { MOVABLE_STATUSES } from '../../waitlist/domain/opening-candidates';
import {
  AppointmentConfirmation,
  ClinicBranding,
  ConfirmationAppointment,
  ConfirmationState,
} from '../domain/entities/appointment-confirmation.entity';
import { firstNameOnly } from './confirmation-token';
import {
  isLateLinkCancellation,
  type LinkCancellationPolicy,
} from '../domain/link-cancellation-policy';

/** Acción del paciente tal como viaja por la API pública. */
export type ConfirmationAction = 'confirm' | 'cancel' | 'call_me';

export const ACTION_TO_RESPONSE: Readonly<
  Record<ConfirmationAction, AppointmentConfirmationResponse>
> = {
  confirm: AppointmentConfirmationResponse.CONFIRM,
  cancel: AppointmentConfirmationResponse.CANCEL,
  call_me: AppointmentConfirmationResponse.CALL_ME,
};

const RESPONSE_TO_ACTION: Readonly<
  Record<AppointmentConfirmationResponse, ConfirmationAction>
> = {
  CONFIRM: 'confirm',
  CANCEL: 'cancel',
  CALL_ME: 'call_me',
};

/**
 * Lo único que la página pública ve de la cita: nombre de pila, cuándo, con
 * quién y dónde. Nada clínico (ni motivo, ni notas, ni apellidos, ni teléfono).
 */
export interface PublicAppointmentView {
  patientFirstName: string | null;
  start: Date;
  end: Date;
  providerName: string | null;
  locationName: string;
  locationAddress: string | null;
  /** DX-354: zona, locale y reloj de la sede de la cita, en crudo (null si no los tiene). */
  timeZone: string | null;
  locale: string | null;
  hourCycle: HourCycle | null;
  /** DX-437: «Avisarme si se libera un hueco antes» y la franja pedida. */
  wantsEarlier: boolean;
  earlierWindow: EarlierWindow | null;
  /**
   * DX-437: el paciente puede pedirlo (o quitarlo) ahora: cita agendada o
   * confirmada, en el futuro y de un día posterior a hoy en la sede (hoy ya no
   * hay huecos anteriores). Sin zona de la sede, no.
   */
  earlierAllowed: boolean;
}

/** DX-437: por qué no se puede pedir adelantar la cita (400 de la ruta pública). */
export const EARLIER_MESSAGES = {
  notMovable: 'Esta cita ya no se puede adelantar.',
  past: 'La cita ya pasó.',
  today: 'La cita es hoy: ya no hay huecos anteriores.',
  noZone:
    'No podemos gestionar esta petición en línea. Llama a la clínica si quieres venir antes.',
} as const;

/** DX-437: la regla de «se puede pedir adelantar», compartida por la vista y la ruta. */
export function earlierBlock(
  appointment: Pick<
    ConfirmationAppointment,
    'start' | 'status' | 'locationTimeZone'
  >,
  now: Date,
): keyof typeof EARLIER_MESSAGES | null {
  if (!MOVABLE_STATUSES.includes(appointment.status)) return 'notMovable';
  if (appointment.start.getTime() <= now.getTime()) return 'past';
  if (!appointment.locationTimeZone) return 'noZone';
  const zone = appointment.locationTimeZone;
  if (civilDateIn(appointment.start, zone) <= civilDateIn(now, zone))
    return 'today';
  return null;
}

/** DX-291: la política que lee el paciente antes de responder. */
export interface PublicCancellationPolicyView {
  /** La versión mostrada: la página la devuelve al responder. */
  policyVersionId: string;
  noticeHours: number;
  /** Texto de la clínica para el paciente (puede ir vacío). */
  text: string;
  suggestedFee: number | null;
  currency: string | null;
}

export interface PublicConfirmationView {
  status: ConfirmationState;
  clinic: ClinicBranding | null;
  /** `null` cuando el enlace caducó: un enlace sin efecto no enseña la cita. */
  appointment: PublicAppointmentView | null;
  response: ConfirmationAction | null;
  respondedAt: Date | null;
  /** DX-291: solo con el enlace PENDING y si la sede tiene política. */
  cancellationPolicy: PublicCancellationPolicyView | null;
  /**
   * DX-291: cancelar AHORA sería tardío (menos aviso que la política): la
   * página lo avisa y cancelar exige `acknowledgePolicy`.
   */
  isLate: boolean;
}

export function toPublicAppointmentView(
  appointment: ConfirmationAppointment,
  now: Date = new Date(),
): PublicAppointmentView {
  return {
    wantsEarlier: appointment.wantsEarlier,
    earlierWindow: appointment.wantsEarlier ? appointment.earlierWindow : null,
    earlierAllowed: earlierBlock(appointment, now) === null,
    patientFirstName: firstNameOnly(appointment.patientFirstName),
    start: appointment.start,
    end: appointment.end,
    providerName: appointment.providerName,
    locationName: appointment.locationName,
    locationAddress: appointment.locationAddress,
    timeZone: appointment.locationTimeZone,
    locale: appointment.locationLocale,
    hourCycle: appointment.locationHourCycle,
  };
}

export function toPublicConfirmationView(
  status: ConfirmationState,
  confirmation: AppointmentConfirmation,
  appointment: ConfirmationAppointment | null,
  clinic: ClinicBranding | null,
  policy: LinkCancellationPolicy | null = null,
  now: Date = new Date(),
): PublicConfirmationView {
  const pending = status === 'PENDING' && appointment !== null;
  return {
    status,
    clinic,
    appointment:
      status !== 'EXPIRED' && appointment
        ? toPublicAppointmentView(appointment, now)
        : null,
    response:
      status === 'RESPONDED' && confirmation.response
        ? RESPONSE_TO_ACTION[confirmation.response]
        : null,
    respondedAt: status === 'RESPONDED' ? confirmation.respondedAt : null,
    cancellationPolicy:
      pending && policy
        ? {
            policyVersionId: policy.id,
            noticeHours: policy.noticeHours,
            text: policy.patientText,
            suggestedFee: policy.suggestedFee,
            currency: policy.currency,
          }
        : null,
    isLate:
      pending && appointment
        ? isLateLinkCancellation(appointment.start, now, policy)
        : false,
  };
}
