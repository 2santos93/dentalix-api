import { endSentence } from '../../../shared/format/end-sentence';
import {
  UI_LANGUAGE,
  type RegionalFormat,
} from '../../../shared/format/regional-format';
import {
  resolveLocalizedText,
  type LocalizedTextMap,
} from '../../../shared/i18n/localized-text';
import { primaryLanguage } from '../../../shared/i18n/patient-language';
import type { MessageLanguage, MessageText } from './message-catalog';
import { renderMessageTemplate } from './message-template-engine';
import type { MessageValues } from './message-variables';

/**
 * DX-565: los textos prellenados de `wa.me` que antes componía la web
 * (`confirmationMessage` y `linkOfferMessage`), ahora en la API con la
 * plantilla de la clínica. Sin plantilla guardada, palabra por palabra lo que
 * escribía la web (la prueba lo fija). Nada clínico: un chat no es un canal
 * seguro.
 */

/** Tope del mensaje entero de confirmación (como la web, DX-564): se recortan las indicaciones. */
export const CONFIRMATION_MESSAGE_MAX = 1500;

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * «martes, 20 de octubre»: el día del instante en la zona de la sede, en las
 * palabras de la app (siempre español, DX-315), como `longAppointmentDay` de
 * la web.
 */
export function longAppointmentDay(start: Date, timeZone: string): string {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(UI_LANGUAGE, {
      timeZone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      calendar: 'gregory',
      numberingSystem: 'latn',
    });
    dayFormatters.set(timeZone, formatter);
  }
  return formatter.format(start);
}

/** El día («martes, 20 de octubre») y la hora con el reloj de la sede. */
export function sedeDayAndTime(
  start: Date,
  timeZone: string,
  fmt: RegionalFormat,
): { day: string; time: string } {
  return {
    day: longAppointmentDay(start, timeZone),
    time: fmt.time(start, timeZone),
  };
}

/** El idioma del mensaje de confirmación: inglés si la base del paciente lo es; si no, español. */
export function confirmationMessageLanguage(
  tag: string | null | undefined,
): MessageLanguage {
  const lower = tag?.trim().toLowerCase();
  if (!lower) return 'es';
  return primaryLanguage(lower) === 'en' ? 'en' : 'es';
}

interface ConfirmationCopy {
  greeting: (name: string | null) => string;
  body: (p: {
    day: string;
    time: string;
    withWhom: string;
    where: string;
    url: string;
  }) => string;
  withWhom: (provider: string) => string;
  anamnesisLink: (url: string) => string;
  anamnesisPending: string;
  preVisitLead: string;
}

/** El texto de siempre (el `MESSAGE_COPY` de la web). */
const CONFIRMATION_COPY: Record<MessageLanguage, ConfirmationCopy> = {
  es: {
    greeting: (name) => (name ? `Hola ${name}` : 'Hola'),
    body: ({ day, time, withWhom, where, url }) =>
      `te recordamos tu cita del ${day} a las ${time}${withWhom} en ${where}. ` +
      `Confírmala, cancélala o pide que te llamemos aquí: ${url}`,
    withWhom: (provider) => ` con ${provider}`,
    anamnesisLink: (url) =>
      ` Antes de la cita, responde el cuestionario de salud: ${url}`,
    anamnesisPending:
      ' Si aún no completaste el cuestionario de salud, usa el enlace que te enviamos.',
    preVisitLead: 'Antes de tu cita:',
  },
  en: {
    greeting: (name) => (name ? `Hello ${name}` : 'Hello'),
    body: ({ day, time, withWhom, where, url }) =>
      `this is a reminder of your appointment on ${day} at ${time}${withWhom} at ${where}. ` +
      `Confirm it, cancel it or ask us to call you here: ${url}`,
    withWhom: (provider) => ` with ${provider}`,
    anamnesisLink: (url) =>
      ` Before your appointment, please answer the health questionnaire: ${url}`,
    anamnesisPending:
      ' If you have not completed the health questionnaire yet, please use the link we sent you.',
    preVisitLead: 'Before your appointment:',
  },
};

/** Recorta a `max` caracteres (code points) con «…» al final. */
function truncate(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  if (max <= 1) return '…';
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

export interface ConfirmationWhatsAppInput {
  url: string;
  patientFirstName: string | null;
  /** Día y hora de la cita en la sede (`sedeDayAndTime`). */
  day: string;
  time: string;
  providerName: string | null;
  locationName: string;
  locationAddress: string | null;
  clinicName: string;
  anamnesisUrl: string | null;
  anamnesisPending: boolean;
  /** Idioma preferido del paciente (`null` = el de la clínica). */
  patientLanguage: string | null;
  /** DX-564: las indicaciones previas del tipo, por idioma. */
  preVisitInstructions: LocalizedTextMap | null;
}

/** Los valores de la plantilla de confirmación (los mismos datos que pinta la web). */
export function confirmationWhatsAppValues(
  input: ConfirmationWhatsAppInput,
): MessageValues {
  return {
    paciente: input.patientFirstName,
    clinica: input.clinicName,
    sede: input.locationName,
    direccion: input.locationAddress,
    fecha: input.day,
    hora: input.time,
    profesional: input.providerName,
    enlace: input.url,
  };
}

/**
 * El mensaje de WhatsApp del enlace de confirmación, en el idioma del
 * paciente: el cuerpo de la clínica (`override`, para `language`) o el de
 * siempre, y detrás, fijos, el cuestionario de salud y «Antes de tu cita: …»
 * recortado para no pasar de {@link CONFIRMATION_MESSAGE_MAX}.
 */
export function confirmationWhatsAppText(
  input: ConfirmationWhatsAppInput,
  override: MessageText | null,
): string {
  const language = confirmationMessageLanguage(input.patientLanguage);
  const t = CONFIRMATION_COPY[language];
  const custom = override
    ? renderMessageTemplate(
        'appointment-confirmation',
        'WHATSAPP',
        override,
        confirmationWhatsAppValues(input),
      )?.body
    : null;
  const where = input.locationAddress
    ? `${input.locationName} (${input.locationAddress})`
    : input.locationName;
  const anamnesis = input.anamnesisUrl
    ? t.anamnesisLink(input.anamnesisUrl)
    : input.anamnesisPending
      ? t.anamnesisPending
      : '';
  const base =
    (custom ??
      `${t.greeting(input.patientFirstName)}, ` +
        t.body({
          day: input.day,
          time: input.time,
          withWhom: input.providerName ? t.withWhom(input.providerName) : '',
          where,
          url: input.url,
        })) + anamnesis;

  const instruction = resolveLocalizedText(
    input.preVisitInstructions,
    input.patientLanguage,
  );
  const text = instruction?.text.trim();
  if (!text) return base;
  const head = `\n\n${t.preVisitLead} `;
  const room = CONFIRMATION_MESSAGE_MAX - [...base].length - [...head].length;
  // Sin sitio ni para unas palabras: el mensaje va sin el bloque.
  if (room < 20) return base;
  return base + head + truncate(instruction!.text, room);
}

export interface LinkOfferWhatsAppInput {
  /** Nombre del paciente tal como está en la ficha (se usa el de pila). */
  firstName: string;
  /** Día y hora del hueco en la sede (`sedeDayAndTime`). */
  day: string;
  time: string;
  locationName: string;
  providerName: string | null;
  clinicName: string;
  url: string;
  expiresAtLabel: string;
}

export function linkOfferWhatsAppValues(
  input: LinkOfferWhatsAppInput,
): MessageValues {
  return {
    paciente: input.firstName.trim().split(/\s+/)[0] ?? '',
    clinica: input.clinicName,
    sede: input.locationName,
    fecha: input.day,
    hora: input.time,
    profesional: input.providerName,
    caduca: input.expiresAtLabel,
    enlace: input.url,
  };
}

/**
 * El mensaje de WhatsApp de la oferta de hueco con enlace (DX-435): el
 * cuerpo de la clínica o el de siempre (`linkOfferMessage` de la web). Solo
 * en español (la oferta no tiene catálogo en otro idioma).
 */
export function linkOfferWhatsAppText(
  input: LinkOfferWhatsAppInput,
  override: MessageText | null,
): string {
  const values = linkOfferWhatsAppValues(input);
  if (override) {
    const custom = renderMessageTemplate(
      'slot-offer',
      'WHATSAPP',
      override,
      values,
    );
    if (custom) return custom.body;
  }
  const first = values.paciente ?? '';
  const greeting = first ? `Hola ${first}` : 'Hola';
  const withWhom = input.providerName ? ` con ${input.providerName}` : '';
  // «10:00 a. m.» ya trae su punto: `endSentence` no pone otro.
  const slot = endSentence(
    `${greeting}, te escribimos de ${input.locationName}. Se liberó un hueco el ` +
      `${values.fecha} a las ${values.hora}${withWhom}`,
  );
  return `${slot} Si te viene bien, acéptalo aquí (se lo queda el primero que lo acepte): ${input.url}`;
}
