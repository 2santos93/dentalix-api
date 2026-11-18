import type { EmailLocale } from '../../../domain/email-message';

/**
 * DX-561: textos del aviso de seguimiento de un presupuesto presentado, por
 * clave y por idioma (DX-497: nunca `if (locale === 'en')` en la plantilla).
 * SOLO el nombre de la clínica, el saludo, un texto neutro, los enlaces y la
 * baja: ni importes, ni tratamientos, ni la etiqueta de la opción (puede
 * nombrar el tratamiento: «Opción A: implante»), ni el profesional.
 */
export interface QuoteFollowUpTexts {
  htmlLang: string;
  subject: (clinic: string) => string;
  heading: (name: string | null) => string;
  /** `patient`: el nombre de pila del menor si escribe a su responsable. */
  intro: (clinic: string, patient: string | null) => string;
  /** Un solo enlace: el botón. */
  action: string;
  /** Varias opciones: la frase y la etiqueta de cada una (A, B, C). */
  optionsLead: string;
  option: (letter: string) => string;
  note: string;
  /** Caducidad del enlace en horas (SIGNATURE_LINK_TTL_HOURS). */
  expires: (hours: number) => string;
  unsubscribeLead: string;
  unsubscribeLabel: string;
  buttonFallback: string;
  footerClinic: (clinic: string, product: string) => string;
  footerPlatform: (product: string) => string;
}

export const QUOTE_FOLLOW_UP_CATALOG: Readonly<
  Record<EmailLocale, QuoteFollowUpTexts>
> = {
  es: {
    htmlLang: 'es',
    subject: (clinic) => `Tienes un presupuesto pendiente en ${clinic}`,
    heading: (name) => (name ? `Hola, ${name}` : 'Hola'),
    intro: (clinic, patient) =>
      patient
        ? `Hay un presupuesto de ${patient} pendiente de revisar en ${clinic}.`
        : `Tienes un presupuesto pendiente de revisar en ${clinic}.`,
    action: 'Ver y aceptar el presupuesto',
    optionsLead: 'Elige la opción que quieres revisar:',
    option: (letter) => `Opción ${letter}`,
    note: 'El enlace es personal. Si tienes dudas o prefieres hablarlo, responde a la clínica por su canal habitual. Si no esperabas este correo, ignóralo.',
    expires: (hours) => `El enlace caduca en ${hours} horas.`,
    unsubscribeLead: '¿No quieres recibir más avisos de la clínica?',
    unsubscribeLabel: 'Dejar de recibir avisos',
    buttonFallback:
      'Si el botón no funciona, copia este enlace en tu navegador:',
    footerClinic: (clinic, product) =>
      `Enviado por ${clinic} a través de ${product}.`,
    footerPlatform: (product) => `Enviado por ${product}.`,
  },
  en: {
    htmlLang: 'en',
    subject: (clinic) => `You have a pending quote at ${clinic}`,
    heading: (name) => (name ? `Hello ${name},` : 'Hello,'),
    intro: (clinic, patient) =>
      patient
        ? `There is a quote for ${patient} waiting for review at ${clinic}.`
        : `You have a quote waiting for review at ${clinic}.`,
    action: 'View and accept the quote',
    optionsLead: 'Choose the option you want to review:',
    option: (letter) => `Option ${letter}`,
    note: 'The link is personal. If you have questions or would rather talk it over, contact the clinic through its usual channel. If you were not expecting this email, ignore it.',
    expires: (hours) => `The link expires in ${hours} hours.`,
    unsubscribeLead: 'Don’t want to receive more notices from the clinic?',
    unsubscribeLabel: 'Stop receiving notices',
    buttonFallback:
      'If the button does not work, copy this link into your browser:',
    footerClinic: (clinic, product) => `Sent by ${clinic} via ${product}.`,
    footerPlatform: (product) => `Sent by ${product}.`,
  },
};
