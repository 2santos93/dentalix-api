import type { MessageVariable } from './message-variables';

/**
 * DX-565: catálogo CERRADO de los mensajes al paciente que la clínica puede
 * reescribir (porción 1). Por clave: los canales, y por canal los idiomas con
 * texto por defecto, las variables permitidas, las obligatorias y el texto
 * por defecto, que es el que sale hoy (la prueba de equivalencia lo
 * comprueba). Sin fila guardada, el mensaje sale con el código de siempre.
 *
 * Qué NO es editable (estructura fija del layout): cabecera y saludo, botón
 * con su enlace, pie, baja (DX-128), política de cancelación, anamnesis,
 * calendario, «Antes de tu cita» (DX-564), la lista de fechas de una serie,
 * el aviso del código de firma y las notas de caducidad.
 *
 * Sintaxis del texto: `{variable}` y tramos opcionales entre corchetes, que
 * solo salen si TODAS sus variables tienen valor: «Hola[ {paciente}]»,
 * «[ con {profesional}]».
 */
export const MESSAGE_KEYS = [
  'appointment-reminder',
  'appointment-confirmation',
  'slot-offer',
  'quote-follow-up',
  'appointment-series',
  'signature-request',
] as const;
export type MessageKey = (typeof MESSAGE_KEYS)[number];

export const MESSAGE_CHANNELS = ['EMAIL', 'WHATSAPP'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

/** Idiomas con texto por defecto (los de `EMAIL_LOCALES`). */
export const MESSAGE_LANGUAGES = ['es', 'en'] as const;
export type MessageLanguage = (typeof MESSAGE_LANGUAGES)[number];

/** Topes (caracteres, tras normalizar). */
export const MESSAGE_SUBJECT_MAX = 150;
export const MESSAGE_EMAIL_BODY_MAX = 2000;
export const MESSAGE_WHATSAPP_BODY_MAX = 1000;

/**
 * Topes del texto YA renderizado (con valores reales). Al guardar se calcula
 * el peor caso con el largo máximo de cada variable; al enviar, si un texto
 * se pasa, sale el texto por defecto. WhatsApp deja sitio al cuestionario de
 * salud y a «Antes de tu cita» dentro de los 1500 del mensaje entero.
 */
export const MESSAGE_SUBJECT_RENDERED_MAX = 200;
export const MESSAGE_EMAIL_BODY_RENDERED_MAX = 4000;
export const MESSAGE_WHATSAPP_RENDERED_MAX = 1300;

export function messageRenderedBodyMax(channel: MessageChannel): number {
  return channel === 'EMAIL'
    ? MESSAGE_EMAIL_BODY_RENDERED_MAX
    : MESSAGE_WHATSAPP_RENDERED_MAX;
}

/**
 * DX-565: la sintaxis y sus límites, para la ayuda del editor (GET).
 */
export const MESSAGE_SYNTAX_HELP =
  'Escribe las variables entre llaves, como {paciente}. Lo que va entre corchetes solo sale si todas sus variables tienen valor, como [ con {profesional}]. Una línea en blanco separa párrafos. Las llaves { } y los corchetes [ ] solo sirven para eso: no se pueden escribir como texto. Sin enlaces, direcciones web, correos ni HTML: en el email el enlace va en el botón y en WhatsApp con {enlace}.';

export function messageBodyMax(channel: MessageChannel): number {
  return channel === 'EMAIL'
    ? MESSAGE_EMAIL_BODY_MAX
    : MESSAGE_WHATSAPP_BODY_MAX;
}

export interface MessageText {
  /** Solo email; null en WhatsApp. */
  subject: string | null;
  body: string;
}

export interface MessageChannelSpec {
  /** Variables del cuerpo (y del asunto, salvo `{enlace}`). */
  variables: readonly MessageVariable[];
  /** Variables que el cuerpo tiene que llevar. */
  required: readonly MessageVariable[];
  /** Texto por defecto por idioma: los idiomas que se pueden editar. */
  defaults: Readonly<Partial<Record<MessageLanguage, MessageText>>>;
  /**
   * Como `endSentence`: tras CUALQUIER variable que acabe en «.», el «.» del
   * texto no se dobla (el texto de siempre de ese mensaje lo hace así). Sin
   * él, solo tras `{hora}` y `{caduca}` («9:30 a. m.»).
   */
  endSentence?: boolean;
}

export interface MessageSpec {
  key: MessageKey;
  /** Título en Ajustes › Mensajes. */
  title: string;
  /** Qué es y cuándo sale. */
  description: string;
  /** Con artículo, para los errores: «no se puede usar en el recordatorio». */
  noun: string;
  /**
   * Al responsable de un menor le llega siempre el texto por defecto (el
   * editable habla de «tu cita» y saluda al destinatario).
   */
  guardianUsesDefault: boolean;
  channels: Readonly<Partial<Record<MessageChannel, MessageChannelSpec>>>;
}

const APPOINTMENT_VARS: readonly MessageVariable[] = [
  'paciente',
  'clinica',
  'sede',
  'direccion',
  'fecha',
  'hora',
  'profesional',
];

export const MESSAGE_CATALOG: Readonly<Record<MessageKey, MessageSpec>> = {
  'appointment-reminder': {
    key: 'appointment-reminder',
    title: 'Recordatorio de cita',
    description:
      'El email automático antes de la cita. El botón para confirmar, la política de cancelación, el cuestionario de salud, el calendario y las indicaciones previas se añaden solos.',
    noun: 'el recordatorio',
    guardianUsesDefault: true,
    channels: {
      EMAIL: {
        variables: APPOINTMENT_VARS,
        required: [],
        defaults: {
          es: {
            subject: 'Recordatorio de tu cita en {clinica}',
            body:
              'Te recordamos tu cita en {clinica}.\n\n' +
              'Fecha y hora: {fecha}[ a las {hora}] (hora de la sede)\n\n' +
              'Sede: {sede}[ ({direccion})]\n\n' +
              '[Profesional: {profesional}]',
          },
          en: {
            subject: 'Reminder: your appointment at {clinica}',
            body:
              'This is a reminder of your appointment at {clinica}.\n\n' +
              'Date and time: {fecha}[ a las {hora}] (local time at the clinic)\n\n' +
              'Location: {sede}[ ({direccion})]\n\n' +
              '[Provider: {profesional}]',
          },
        },
      },
    },
  },
  'appointment-confirmation': {
    key: 'appointment-confirmation',
    title: 'Confirmación de cita por WhatsApp',
    description:
      'El mensaje prellenado de WhatsApp con el enlace para confirmar, cancelar o pedir que te llamen. El cuestionario de salud y las indicaciones previas se añaden solos.',
    noun: 'la confirmación por WhatsApp',
    guardianUsesDefault: false,
    channels: {
      WHATSAPP: {
        variables: [...APPOINTMENT_VARS, 'enlace'],
        required: ['enlace'],
        defaults: {
          es: {
            subject: null,
            body: 'Hola[ {paciente}], te recordamos tu cita del {fecha} a las {hora}[ con {profesional}] en {sede}[ ({direccion})]. Confírmala, cancélala o pide que te llamemos aquí: {enlace}',
          },
          en: {
            subject: null,
            body: 'Hello[ {paciente}], this is a reminder of your appointment on {fecha} at {hora}[ with {profesional}] at {sede}[ ({direccion})]. Confirm it, cancel it or ask us to call you here: {enlace}',
          },
        },
      },
    },
  },
  'slot-offer': {
    key: 'slot-offer',
    title: 'Oferta de hueco libre',
    description:
      'La oferta con enlace de un hueco que se liberó, por email o WhatsApp. La caducidad y el botón se añaden solos en el email.',
    noun: 'la oferta de hueco',
    guardianUsesDefault: false,
    channels: {
      EMAIL: {
        variables: [
          'paciente',
          'clinica',
          'sede',
          'fecha',
          'hora',
          'profesional',
          'caduca',
        ],
        required: [],
        defaults: {
          es: {
            subject: '{clinica} tiene un hueco libre para ti',
            body:
              'Se liberó un hueco el {fecha}[ a las {hora}] en {sede}[ con {profesional}].\n\n' +
              'Si te viene bien, ábrelo y acéptalo: se lo queda el primero que lo acepte. Si no, puedes rechazarlo desde el mismo enlace.',
          },
        },
      },
      WHATSAPP: {
        variables: [
          'paciente',
          'clinica',
          'sede',
          'fecha',
          'hora',
          'profesional',
          'caduca',
          'enlace',
        ],
        required: ['enlace'],
        // `linkOfferMessage` de siempre cierra la frase con `endSentence`.
        endSentence: true,
        defaults: {
          es: {
            subject: null,
            body: 'Hola[ {paciente}], te escribimos de {sede}. Se liberó un hueco el {fecha} a las {hora}[ con {profesional}]. Si te viene bien, acéptalo aquí (se lo queda el primero que lo acepte): {enlace}',
          },
        },
      },
    },
  },
  'quote-follow-up': {
    key: 'quote-follow-up',
    title: 'Seguimiento de presupuesto',
    description:
      'El aviso automático de un presupuesto presentado y sin respuesta. Los enlaces de las opciones, la caducidad y la baja se añaden solos.',
    noun: 'el seguimiento del presupuesto',
    guardianUsesDefault: true,
    channels: {
      EMAIL: {
        variables: ['paciente', 'clinica'],
        required: [],
        defaults: {
          es: {
            subject: 'Tienes un presupuesto pendiente en {clinica}',
            body: 'Tienes un presupuesto pendiente de revisar en {clinica}.',
          },
          en: {
            subject: 'You have a pending quote at {clinica}',
            body: 'You have a quote waiting for review at {clinica}.',
          },
        },
      },
    },
  },
  'appointment-series': {
    key: 'appointment-series',
    title: 'Aviso de serie de citas',
    description:
      'El email único al crear una serie de citas. La lista de fechas y la baja se añaden solas.',
    noun: 'el aviso de la serie de citas',
    guardianUsesDefault: true,
    channels: {
      EMAIL: {
        variables: ['paciente', 'clinica', 'sede', 'profesional', 'cantidad'],
        required: [],
        defaults: {
          es: {
            subject: 'Tus próximas citas en {clinica}',
            body: 'Te agendamos {cantidad} citas en {sede}[ con {profesional}].',
          },
          en: {
            subject: 'Your upcoming appointments at {clinica}',
            body: 'We booked {cantidad} appointments for you at {sede}[ with {profesional}].',
          },
        },
      },
    },
  },
  'signature-request': {
    key: 'signature-request',
    title: 'Documento para firmar',
    description:
      'El email con el enlace para firmar a distancia. El aviso del código de 6 dígitos, la caducidad y el botón se añaden solos.',
    noun: 'la solicitud de firma',
    guardianUsesDefault: true,
    channels: {
      EMAIL: {
        variables: ['paciente', 'clinica', 'caduca'],
        required: [],
        defaults: {
          es: {
            subject: '{clinica} te envió un documento para firmar',
            body: '{clinica} te envió un documento para que lo leas y lo firmes desde tu teléfono o tu computador.',
          },
          en: {
            subject: '{clinica} sent you a document to sign',
            body: '{clinica} sent you a document to read and sign from your phone or computer.',
          },
        },
      },
    },
  },
};

export function isMessageKey(value: string): value is MessageKey {
  return (MESSAGE_KEYS as readonly string[]).includes(value);
}

export function isMessageChannel(value: string): value is MessageChannel {
  return (MESSAGE_CHANNELS as readonly string[]).includes(value);
}

export function isMessageLanguage(value: string): value is MessageLanguage {
  return (MESSAGE_LANGUAGES as readonly string[]).includes(value);
}

/** El canal de una clave, o null si esa clave no se envía por ese canal. */
export function messageChannelSpec(
  key: MessageKey,
  channel: MessageChannel,
): MessageChannelSpec | null {
  return MESSAGE_CATALOG[key].channels[channel] ?? null;
}

/** Texto por defecto de (clave, canal, idioma), o null si no existe. */
export function defaultMessageText(
  key: MessageKey,
  channel: MessageChannel,
  language: MessageLanguage,
): MessageText | null {
  return messageChannelSpec(key, channel)?.defaults[language] ?? null;
}

/**
 * Los idiomas editables para la clínica: los del catálogo que su lista de
 * idiomas de pacientes ofrece (por idioma base: «en-US» ofrece «en»). El
 * español, siempre (es el de la clínica).
 */
export function offeredMessageLanguages(
  patientLanguages: readonly string[],
): MessageLanguage[] {
  const bases = new Set(
    patientLanguages.map((tag) => tag.trim().toLowerCase().split('-')[0]),
  );
  return MESSAGE_LANGUAGES.filter((l) => l === 'es' || bases.has(l));
}
