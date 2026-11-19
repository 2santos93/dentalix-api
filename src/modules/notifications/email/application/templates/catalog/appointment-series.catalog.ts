import type { EmailLocale } from '../../../domain/email-message';

/**
 * DX-562: textos del aviso único de una serie de citas, por clave y por
 * idioma (DX-497: nunca `if (locale === 'en')` en la plantilla). Solo la
 * clínica, la sede, el profesional y las fechas (ya formateadas con el
 * formato y la zona de la sede): ni motivo, ni notas, ni tratamiento, ni
 * importes.
 */
export interface AppointmentSeriesTexts {
  htmlLang: string;
  /** `patient`: el nombre de pila del menor si escribe a su responsable. */
  subject: (clinic: string, patient: string | null) => string;
  heading: (name: string | null) => string;
  intro: (input: {
    count: number;
    location: string;
    provider: string | null;
    patient: string | null;
  }) => string;
  datesLead: string;
  note: string;
  buttonFallback: string;
  footerClinic: (clinic: string, product: string) => string;
  footerPlatform: (product: string) => string;
}

export const APPOINTMENT_SERIES_CATALOG: Readonly<
  Record<EmailLocale, AppointmentSeriesTexts>
> = {
  es: {
    htmlLang: 'es',
    subject: (clinic, patient) =>
      patient
        ? `Las próximas citas de ${patient} en ${clinic}`
        : `Tus próximas citas en ${clinic}`,
    heading: (name) => (name ? `Hola, ${name}` : 'Hola'),
    intro: ({ count, location, provider, patient }) => {
      const where = `en ${location}${provider ? ` con ${provider}` : ''}`;
      return patient
        ? `Agendamos ${count} citas de ${patient} ${where}.`
        : `Te agendamos ${count} citas ${where}.`;
    },
    datesLead: 'Fechas y horas:',
    note: 'Si necesitas cambiar o cancelar alguna, avisa a la clínica por su canal habitual. Si no esperabas este correo, avisa a la clínica.',
    buttonFallback:
      'Si el botón no funciona, copia este enlace en tu navegador:',
    footerClinic: (clinic, product) =>
      `Enviado por ${clinic} a través de ${product}.`,
    footerPlatform: (product) => `Enviado por ${product}.`,
  },
  en: {
    htmlLang: 'en',
    subject: (clinic, patient) =>
      patient
        ? `Upcoming appointments for ${patient} at ${clinic}`
        : `Your upcoming appointments at ${clinic}`,
    heading: (name) => (name ? `Hello ${name},` : 'Hello,'),
    intro: ({ count, location, provider, patient }) => {
      const where = `at ${location}${provider ? ` with ${provider}` : ''}`;
      return patient
        ? `We booked ${count} appointments for ${patient} ${where}.`
        : `We booked ${count} appointments for you ${where}.`;
    },
    datesLead: 'Dates and times:',
    note: 'If you need to change or cancel any of them, contact the clinic through its usual channel. If you were not expecting this email, let the clinic know.',
    buttonFallback:
      'If the button does not work, copy this link into your browser:',
    footerClinic: (clinic, product) => `Sent by ${clinic} via ${product}.`,
    footerPlatform: (product) => `Sent by ${product}.`,
  },
};
