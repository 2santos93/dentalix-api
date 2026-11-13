import type { EmailLocale } from '../../../domain/email-message';

/**
 * DX-497: catálogo de textos del recordatorio de cita, POR CLAVE y por idioma
 * (nunca `if (locale === 'en')` en la plantilla). Todo lo que lee el paciente
 * en ese email sale de aquí: asunto, cuerpo, botón, enlaces, pie, política de
 * cancelación y el evento de Google Calendar. La plantilla solo los coloca
 * (la prueba de arquitectura `appointment-reminder.architecture.spec.ts`
 * comprueba que no le queda ningún literal para el paciente).
 *
 * La fecha y la hora NO son del catálogo: llegan ya escritas con el locale y
 * la zona de la sede (DX-315), sea cual sea el idioma del paciente.
 *
 * Añadir un idioma = añadir su entrada aquí y en `EMAIL_LOCALES`; el tipo
 * obliga a dar TODAS las claves.
 */
export interface AppointmentReminderTexts {
  /** Atributo `lang` del HTML. */
  htmlLang: string;
  /** «tu cita» / «la cita de Ana». */
  ownAppointment: string;
  appointmentOf: (patientName: string) => string;
  subject: (whose: string, clinic: string) => string;
  heading: (name: string) => string;
  intro: (whose: string, clinic: string) => string;
  dateTime: (startsAtLabel: string) => string;
  location: (where: string) => string;
  provider: (providerName: string) => string;
  noteWithLink: string;
  noteWithoutLink: string;
  action: string;
  calendarLead: string;
  calendarIcs: string;
  calendarGoogle: string;
  /** Título y detalle del evento de Google Calendar. */
  calendarSummary: (clinic: string, providerName: string | null) => string;
  calendarDetails: string;
  unsubscribeLead: string;
  unsubscribeLabel: string;
  policyNotice: (noticeHours: number) => string;
  /** Sin el punto final: lo pone `endSentence` (hay monedas que acaban en punto). */
  policyFee: (feeLabel: string) => string;
  /** Pie y ayuda del botón del esqueleto común (`renderLayout`). */
  buttonFallback: string;
  footerClinic: (clinic: string, product: string) => string;
  footerPlatform: (product: string) => string;
}

export const APPOINTMENT_REMINDER_CATALOG: Readonly<
  Record<EmailLocale, AppointmentReminderTexts>
> = {
  es: {
    htmlLang: 'es',
    ownAppointment: 'tu cita',
    appointmentOf: (patientName) => `la cita de ${patientName}`,
    subject: (whose, clinic) => `Recordatorio de ${whose} en ${clinic}`,
    heading: (name) => `Hola, ${name}`,
    intro: (whose, clinic) => `Te recordamos ${whose} en ${clinic}.`,
    dateTime: (label) => `Fecha y hora: ${label} (hora de la sede)`,
    location: (where) => `Sede: ${where}`,
    provider: (name) => `Profesional: ${name}`,
    noteWithLink:
      'Usa el botón para confirmarla o avisarnos si no puedes asistir.',
    noteWithoutLink:
      'Si no puedes asistir, avísanos con tiempo para darle el espacio a otro paciente.',
    action: 'Confirmar o cancelar',
    calendarLead: 'Añadir a mi calendario:',
    calendarIcs: 'Archivo .ics (Apple, Outlook)',
    calendarGoogle: 'Google Calendar',
    calendarSummary: (clinic, provider) =>
      provider ? `Cita en ${clinic} con ${provider}` : `Cita en ${clinic}`,
    calendarDetails:
      'Si no puedes asistir, avisa a la clínica con tiempo para darle el espacio a otro paciente.',
    unsubscribeLead: '¿No quieres recibir más recordatorios?',
    unsubscribeLabel: 'Dejar de recibir recordatorios',
    policyNotice: (hours) =>
      `Política de cancelación: si no puedes asistir, avísanos con al menos ${hours} h de antelación.`,
    policyFee: (fee) =>
      `La inasistencia o la cancelación con menos aviso puede tener un cargo de ${fee}`,
    buttonFallback:
      'Si el botón no funciona, copia este enlace en tu navegador:',
    footerClinic: (clinic, product) =>
      `Enviado por ${clinic} a través de ${product}.`,
    footerPlatform: (product) => `Enviado por ${product}.`,
  },
  en: {
    htmlLang: 'en',
    ownAppointment: 'your appointment',
    appointmentOf: (patientName) => `${patientName}’s appointment`,
    subject: (whose, clinic) => `Reminder: ${whose} at ${clinic}`,
    heading: (name) => `Hello ${name},`,
    intro: (whose, clinic) => `This is a reminder of ${whose} at ${clinic}.`,
    dateTime: (label) => `Date and time: ${label} (local time at the clinic)`,
    location: (where) => `Location: ${where}`,
    provider: (name) => `Provider: ${name}`,
    noteWithLink:
      'Use the button to confirm it or to let us know if you cannot make it.',
    noteWithoutLink:
      'If you cannot make it, please let us know in advance so we can offer the slot to another patient.',
    action: 'Confirm or cancel',
    calendarLead: 'Add to my calendar:',
    calendarIcs: '.ics file (Apple, Outlook)',
    calendarGoogle: 'Google Calendar',
    calendarSummary: (clinic, provider) =>
      provider
        ? `Appointment at ${clinic} with ${provider}`
        : `Appointment at ${clinic}`,
    calendarDetails:
      'If you cannot make it, please let the clinic know in advance so they can offer the slot to another patient.',
    unsubscribeLead: 'Don’t want to receive more reminders?',
    unsubscribeLabel: 'Stop receiving reminders',
    policyNotice: (hours) =>
      `Cancellation policy: if you cannot make it, please let us know at least ${hours} h in advance.`,
    policyFee: (fee) =>
      `Missing the appointment or cancelling with less notice may incur a fee of ${fee}`,
    buttonFallback:
      'If the button does not work, copy this link into your browser:',
    footerClinic: (clinic, product) => `Sent by ${clinic} via ${product}.`,
    footerPlatform: (product) => `Sent by ${product}.`,
  },
};
