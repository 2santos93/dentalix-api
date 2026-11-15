import type { EmailLocale } from '../../../domain/email-message';

/**
 * DX-468: textos de la copia de la receta para el paciente, por clave y por
 * idioma (DX-497: nunca `if (locale === 'en')` en la plantilla). Los usan el
 * email (`prescription-copy`) y el mensaje prellenado de WhatsApp. Nada
 * clínico: ni medicamentos, ni diagnóstico, ni el profesional; quién lo
 * envía, para quién y el enlace. La caducidad llega ya escrita con el formato
 * de la sede (numérica, igual en cualquier idioma).
 */
export interface PrescriptionCopyTexts {
  htmlLang: string;
  subject: (clinic: string) => string;
  heading: (name: string | null) => string;
  /** `patient`: el nombre de pila del menor si escribe a su responsable. */
  intro: (clinic: string, patient: string | null) => string;
  /** Lo que dice el pie de la copia: no sirve para retirar el medicamento. */
  notOfficial: string;
  note: (expiresAtLabel: string) => string;
  action: string;
  whatsapp: (input: {
    name: string | null;
    clinic: string;
    patient: string | null;
    expiresAtLabel: string;
    url: string;
  }) => string;
  buttonFallback: string;
  footerClinic: (clinic: string, product: string) => string;
  footerPlatform: (product: string) => string;
}

export const PRESCRIPTION_COPY_CATALOG: Readonly<
  Record<EmailLocale, PrescriptionCopyTexts>
> = {
  es: {
    htmlLang: 'es',
    subject: (clinic) => `Tu copia de la receta de ${clinic}`,
    heading: (name) => (name ? `Hola, ${name}` : 'Hola'),
    intro: (clinic, patient) =>
      patient
        ? `${clinic} te envía una copia de la receta de ${patient}. Ábrela desde el enlace.`
        : `${clinic} te envía una copia de tu receta. Ábrela desde el enlace.`,
    notOfficial:
      'Es una copia informativa: para retirar el medicamento hay que presentar la receta impresa y firmada.',
    note: (expires) =>
      `El enlace es personal y caduca el ${expires}. Si no esperabas este correo, no lo abras y avisa a la clínica.`,
    action: 'Ver mi copia',
    whatsapp: ({ name, clinic, patient, expiresAtLabel, url }) => {
      const greeting = name ? `Hola ${name}` : 'Hola';
      const what = patient
        ? `la copia de la receta de ${patient}`
        : 'la copia de su receta';
      return `${greeting}, le saludamos de ${clinic}. Aquí tiene ${what} (enlace personal, caduca el ${expiresAtLabel}): ${url}`;
    },
    buttonFallback:
      'Si el botón no funciona, copia este enlace en tu navegador:',
    footerClinic: (clinic, product) =>
      `Enviado por ${clinic} a través de ${product}.`,
    footerPlatform: (product) => `Enviado por ${product}.`,
  },
  en: {
    htmlLang: 'en',
    subject: (clinic) => `Your prescription copy from ${clinic}`,
    heading: (name) => (name ? `Hello ${name},` : 'Hello,'),
    intro: (clinic, patient) =>
      patient
        ? `${clinic} is sending you a copy of ${patient}’s prescription. Open it from the link.`
        : `${clinic} is sending you a copy of your prescription. Open it from the link.`,
    notOfficial:
      'This is an informational copy: to collect the medication, present the printed and signed prescription.',
    note: (expires) =>
      `The link is personal and expires on ${expires}. If you were not expecting this email, do not open it and let the clinic know.`,
    action: 'View my copy',
    whatsapp: ({ name, clinic, patient, expiresAtLabel, url }) => {
      const greeting = name ? `Hello ${name}` : 'Hello';
      const what = patient
        ? `the copy of ${patient}’s prescription`
        : 'the copy of your prescription';
      return `${greeting}, this is ${clinic}. Here is ${what} (personal link, expires on ${expiresAtLabel}): ${url}`;
    },
    buttonFallback:
      'If the button does not work, copy this link into your browser:',
    footerClinic: (clinic, product) => `Sent by ${clinic} via ${product}.`,
    footerPlatform: (product) => `Sent by ${product}.`,
  },
};
