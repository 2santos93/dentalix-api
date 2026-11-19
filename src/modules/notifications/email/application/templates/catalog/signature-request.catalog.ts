import type { EmailLocale } from '../../../domain/email-message';

/**
 * DX-565: textos del email del enlace de firma a distancia (DX-243), por
 * clave y por idioma (DX-497). El español es el de siempre, palabra por
 * palabra. Sin nada clínico: ni el título del documento.
 */
export interface SignatureRequestTexts {
  htmlLang: string;
  subject: (clinic: string) => string;
  heading: (name: string) => string;
  /** `patient`: el nombre de pila del menor si escribe a su responsable. */
  intro: (clinic: string, patient: string | null) => string;
  code: string;
  note: (expiresAtLabel: string) => string;
  action: string;
  buttonFallback: string;
  footerClinic: (clinic: string, product: string) => string;
  footerPlatform: (product: string) => string;
}

export const SIGNATURE_REQUEST_CATALOG: Readonly<
  Record<EmailLocale, SignatureRequestTexts>
> = {
  es: {
    htmlLang: 'es',
    subject: (clinic) => `${clinic} te envió un documento para firmar`,
    heading: (name) => `Hola, ${name}`,
    intro: (clinic, patient) =>
      patient
        ? `${clinic} te envió un documento de ${patient} para que lo leas y lo firmes desde tu teléfono o tu computador.`
        : `${clinic} te envió un documento para que lo leas y lo firmes desde tu teléfono o tu computador.`,
    code: 'Al abrir el enlace te pediremos un código de 6 dígitos que te enviaremos a este mismo correo.',
    note: (expires) =>
      `El enlace caduca el ${expires} y solo sirve una vez. Si no esperabas este correo, no lo abras y avisa a la clínica.`,
    action: 'Ver y firmar',
    buttonFallback:
      'Si el botón no funciona, copia este enlace en tu navegador:',
    footerClinic: (clinic, product) =>
      `Enviado por ${clinic} a través de ${product}.`,
    footerPlatform: (product) => `Enviado por ${product}.`,
  },
  en: {
    htmlLang: 'en',
    subject: (clinic) => `${clinic} sent you a document to sign`,
    heading: (name) => `Hello ${name},`,
    intro: (clinic, patient) =>
      patient
        ? `${clinic} sent you a document for ${patient} to read and sign from your phone or computer.`
        : `${clinic} sent you a document to read and sign from your phone or computer.`,
    code: 'When you open the link we will ask you for a 6-digit code that we will send to this same email address.',
    note: (expires) =>
      `The link expires on ${expires} and can only be used once. If you were not expecting this email, do not open it and let the clinic know.`,
    action: 'View and sign',
    buttonFallback:
      'If the button does not work, copy this link into your browser:',
    footerClinic: (clinic, product) => `Sent by ${clinic} via ${product}.`,
    footerPlatform: (product) => `Sent by ${product}.`,
  },
};
