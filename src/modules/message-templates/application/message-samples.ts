import type { EmailVarsByTemplate } from '../../notifications/email/domain/email-message';
import type { EditableEmailTemplate } from '../../notifications/email/application/templates/editable-text';
import { MESSAGE_VARIABLE_INFO as S } from '../domain/message-variables';
import {
  longAppointmentDay,
  type ConfirmationWhatsAppInput,
  type LinkOfferWhatsAppInput,
} from '../domain/whatsapp-messages';

/**
 * DX-565: datos FICTICIOS de la vista previa y de la prueba (nunca de un
 * paciente real): los ejemplos del catálogo de variables. Solo el nombre de
 * la clínica es el suyo. Sin enlace de baja (la prueba no es un envío real).
 */
/** El día de ejemplo con las palabras del wa.me («martes, 20 de octubre»). */
const SAMPLE_DAY = longAppointmentDay(
  new Date('2026-10-20T12:00:00.000Z'),
  'UTC',
);

const SAMPLE_DATES = [
  `${S.fecha.sample} a las ${S.hora.sample}`,
  `martes 27 de octubre de 2026 a las ${S.hora.sample}`,
  `martes 3 de noviembre de 2026 a las ${S.hora.sample}`,
  `martes 10 de noviembre de 2026 a las ${S.hora.sample}`,
];

export function sampleEmailVars<T extends EditableEmailTemplate>(
  template: T,
  clinicName: string,
): EmailVarsByTemplate[T] {
  const vars: Pick<EmailVarsByTemplate, EditableEmailTemplate> = {
    'appointment-reminder': {
      patientName: S.paciente.sample,
      guardianName: null,
      startsAtLabel: `${S.fecha.sample} a las ${S.hora.sample}`,
      locationName: S.sede.sample,
      locationAddress: S.direccion.sample,
      providerName: S.profesional.sample,
      confirmUrl: S.enlace.sample,
      unsubscribeUrl: null,
      calendar: null,
      cancellationPolicy: null,
    },
    'slot-offer': {
      patientFirstName: S.paciente.sample,
      clinicName,
      slotLabel: `${S.fecha.sample} a las ${S.hora.sample}`,
      locationName: S.sede.sample,
      providerName: S.profesional.sample,
      url: S.enlace.sample,
      expiresAtLabel: S.caduca.sample,
    },
    'quote-follow-up': {
      recipientFirstName: S.paciente.sample,
      patientFirstName: null,
      clinicName,
      urls: [S.enlace.sample],
      expiresInHours: 72,
      unsubscribeUrl: null,
    },
    'appointment-series': {
      recipientFirstName: S.paciente.sample,
      patientFirstName: null,
      clinicName,
      locationName: S.sede.sample,
      providerName: S.profesional.sample,
      dateLabels: SAMPLE_DATES.slice(0, Number(S.cantidad.sample)),
      unsubscribeUrl: null,
    },
    'signature-request': {
      recipientFirstName: S.paciente.sample,
      patientFirstName: null,
      clinicName,
      url: S.enlace.sample,
      expiresAtLabel: S.caduca.sample,
    },
  };
  return vars[template] as EmailVarsByTemplate[T];
}

export function sampleConfirmationInput(
  clinicName: string,
  language: string,
): ConfirmationWhatsAppInput {
  return {
    url: S.enlace.sample,
    patientFirstName: S.paciente.sample,
    day: SAMPLE_DAY,
    time: S.hora.sample,
    providerName: S.profesional.sample,
    locationName: S.sede.sample,
    locationAddress: S.direccion.sample,
    clinicName,
    anamnesisUrl: null,
    anamnesisPending: false,
    patientLanguage: language,
    preVisitInstructions: null,
  };
}

export function sampleLinkOfferInput(
  clinicName: string,
): LinkOfferWhatsAppInput {
  return {
    firstName: S.paciente.sample,
    day: SAMPLE_DAY,
    time: S.hora.sample,
    locationName: S.sede.sample,
    providerName: S.profesional.sample,
    clinicName,
    url: S.enlace.sample,
    expiresAtLabel: S.caduca.sample,
  };
}
