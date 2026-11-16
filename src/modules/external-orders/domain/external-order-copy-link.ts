import {
  PRESCRIPTION_COPY_MINOR_NO_EMAIL_MESSAGE,
  PRESCRIPTION_COPY_MINOR_NO_WHATSAPP_MESSAGE,
  PRESCRIPTION_COPY_NO_EMAIL_MESSAGE,
  PRESCRIPTION_COPY_NO_WHATSAPP_MESSAGE,
  PRESCRIPTION_COPY_OPTED_OUT_MESSAGE,
} from '../../prescriptions/domain/prescription-copy-recipient';
import type { ExternalOrderKind } from './external-order-rules';

/**
 * DX-572: copia de una orden externa para el paciente (o el responsable de un
 * menor) por un enlace de UN SOLO USO, sin adjunto (patrón DX-443). Token de
 * los demás enlaces públicos (`shared/public-links`): 256 bits que viajan
 * solo en el mensaje; en la BD, su SHA-256. Se gasta al DESCARGAR el PDF, no
 * al abrir la página (una vista previa del enlace no lo gasta). Caduca a los
 * 7 días (EXTERNAL_ORDER_COPY_LINK_TTL_HOURS, 1..720); reenviar, anular la
 * orden o archivar al paciente (DX-461) lo invalidan.
 */

const HOUR = 60 * 60_000;

/** Ruta pública de la web (`/orden/copia/<token>`). */
export const EXTERNAL_ORDER_COPY_PUBLIC_PATH = '/orden/copia';

export const EXTERNAL_ORDER_COPY_CONFIG = Symbol('EXTERNAL_ORDER_COPY_CONFIG');

export interface ExternalOrderCopyConfig {
  ttlHours: number;
}

export const EXTERNAL_ORDER_COPY_DEFAULT_TTL_HOURS = 7 * 24;
const TTL_ENV = 'EXTERNAL_ORDER_COPY_LINK_TTL_HOURS';
const MAX_TTL_HOURS = 720;

/** Lee la caducidad del entorno; un valor inválido hace fallar el arranque. */
export function loadExternalOrderCopyConfig(
  get: (key: string) => string | undefined,
): ExternalOrderCopyConfig {
  const raw = get(TTL_ENV)?.trim();
  if (raw === undefined || raw === '') {
    return { ttlHours: EXTERNAL_ORDER_COPY_DEFAULT_TTL_HOURS };
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > MAX_TTL_HOURS) {
    throw new Error(
      `${TTL_ENV} tiene que ser un entero entre 1 y ${MAX_TTL_HOURS} (horas que vale el enlace de la copia de la orden).`,
    );
  }
  return { ttlHours: value };
}

export function externalOrderCopyExpiresAt(now: Date, ttlHours: number): Date {
  return new Date(now.getTime() + ttlHours * HOUR);
}

/** `base` = `<protocolo>://<host de la clínica>` (TenantLinkBaseService). */
export function buildExternalOrderCopyUrl(base: string, token: string): string {
  return `${base}${EXTERNAL_ORDER_COPY_PUBLIC_PATH}/${token}`;
}

export type ExternalOrderCopyChannel = 'EMAIL' | 'WHATSAPP';
export const EXTERNAL_ORDER_COPY_CHANNELS: readonly ExternalOrderCopyChannel[] =
  ['EMAIL', 'WHATSAPP'];

/**
 * Lo que ve quien abre el enlace. `GONE` (caducado, invalidado) no se
 * distingue de un token inventado o de otra clínica: 404 genérico. Usado,
 * mientras no caduque: «enlace usado».
 */
export type ExternalOrderCopyLinkState = 'AVAILABLE' | 'USED' | 'GONE';

export function externalOrderCopyLinkState(
  link: { expiresAt: Date; usedAt: Date | null; revokedAt: Date | null },
  now: Date,
): ExternalOrderCopyLinkState {
  if (link.revokedAt !== null) return 'GONE';
  if (link.expiresAt.getTime() <= now.getTime()) return 'GONE';
  return link.usedAt === null ? 'AVAILABLE' : 'USED';
}

/** 404 genérico: token inventado, de otra clínica, caducado o invalidado. */
export const EXTERNAL_ORDER_COPY_NOT_FOUND_MESSAGE =
  'El enlace no existe o ya no es válido.';
/** 410 al intentar descargar con un enlace ya usado. */
export const EXTERNAL_ORDER_COPY_USED_MESSAGE =
  'Este enlace ya se usó. Si necesitas otra copia de la orden, pídesela a la clínica.';
export const EXTERNAL_ORDER_COPY_USED_CODE = 'EXTERNAL_ORDER_COPY_LINK_USED';
export const EXTERNAL_ORDER_COPY_VOIDED_MESSAGE =
  'La orden está anulada: no se envía al paciente.';
export const EXTERNAL_ORDER_COPY_NO_LINK_HOST_MESSAGE =
  'No se pudo armar el enlace de la clínica: revisa su subdominio.';

/** Motivos de auditoría. */
export const EXTERNAL_ORDER_COPY_SENT_REASON = 'EXTERNAL_ORDER_COPY_SENT';
export const EXTERNAL_ORDER_COPY_OPENED_REASON = 'EXTERNAL_ORDER_COPY_OPENED';
export const EXTERNAL_ORDER_COPY_DOWNLOADED_REASON =
  'EXTERNAL_ORDER_COPY_DOWNLOADED';

/**
 * El destinatario lo resuelve el mismo criterio que la copia de la receta
 * (DX-468: baja de envíos, menor por su responsable que recibe avisos); sus
 * mensajes hablan de la receta, así que se dicen aquí para la orden.
 */
const RECIPIENT_MESSAGES: Record<string, string> = {
  [PRESCRIPTION_COPY_OPTED_OUT_MESSAGE]:
    'El paciente dio de baja los envíos: entrégale la orden impresa.',
  [PRESCRIPTION_COPY_NO_EMAIL_MESSAGE]:
    'El paciente no tiene email: añádelo en su ficha o envíala por WhatsApp.',
  [PRESCRIPTION_COPY_NO_WHATSAPP_MESSAGE]:
    'El paciente no tiene un teléfono que sirva para WhatsApp: escríbelo con + y su prefijo, o envíala por email.',
  [PRESCRIPTION_COPY_MINOR_NO_EMAIL_MESSAGE]:
    'El paciente es menor de edad: registra en su ficha un responsable que reciba avisos y tenga email.',
  [PRESCRIPTION_COPY_MINOR_NO_WHATSAPP_MESSAGE]:
    'El paciente es menor de edad: registra en su ficha un responsable que reciba avisos y tenga un teléfono para WhatsApp.',
};

export function externalOrderRecipientMessage(reason: string): string {
  return RECIPIENT_MESSAGES[reason] ?? reason;
}

type Language = 'es' | 'en';

const WHAT: Record<Language, Record<ExternalOrderKind, string>> = {
  es: {
    IMAGING: 'la orden de estudios de imagen',
    LAB: 'la orden de laboratorio clínico',
    SPECIALIST: 'la referencia al especialista',
    OTHER: 'la orden de estudios',
  },
  en: {
    IMAGING: 'the imaging order',
    LAB: 'the lab test order',
    SPECIALIST: 'the specialist referral',
    OTHER: 'the order',
  },
};

/**
 * Mensaje prellenado de WhatsApp en el idioma del paciente (DX-497): la
 * clínica, qué documento, que el enlace es de un solo uso, la caducidad y el
 * enlace. Nada clínico (ni los estudios, ni el centro, ni la nota).
 */
export function externalOrderWhatsAppText(input: {
  language: string;
  kind: ExternalOrderKind;
  name: string | null;
  clinic: string;
  patient: string | null;
  expiresAtLabel: string;
  url: string;
}): string {
  const lang: Language = input.language === 'en' ? 'en' : 'es';
  const what = WHAT[lang][input.kind];
  if (lang === 'en') {
    const greeting = input.name ? `Hello ${input.name}` : 'Hello';
    const whose = input.patient ? ` for ${input.patient}` : '';
    return `${greeting}, this is ${input.clinic}. Here is ${what}${whose} (personal link, single download, expires on ${input.expiresAtLabel}): ${input.url}`;
  }
  const greeting = input.name ? `Hola ${input.name}` : 'Hola';
  const whose = input.patient ? ` de ${input.patient}` : '';
  return `${greeting}, le saludamos de ${input.clinic}. Aquí tiene ${what}${whose} (enlace personal de una sola descarga, caduca el ${input.expiresAtLabel}): ${input.url}`;
}

/** Qué documento es, para el email (sin nada clínico). */
export const EXTERNAL_ORDER_EMAIL_WHAT: Record<ExternalOrderKind, string> =
  WHAT.es;
