import {
  PRESCRIPTION_COPY_MINOR_NO_WHATSAPP_MESSAGE,
  PRESCRIPTION_COPY_NO_WHATSAPP_MESSAGE,
  PRESCRIPTION_COPY_OPTED_OUT_MESSAGE,
} from '../../prescriptions/domain/prescription-copy-recipient';
import type { CertificateKind } from './certificate-rules';

/**
 * DX-306: copia de un certificado para el paciente (o el responsable de un
 * menor) por un enlace caducable enviado por WhatsApp. Token de los demás
 * enlaces públicos (`shared/public-links`, DX-443/DX-468): 256 bits que
 * viajan solo en el mensaje; en la BD, su SHA-256. No se gasta al abrirlo:
 * sirve hasta que caduca (30 días por defecto), se reenvía (el anterior deja
 * de servir) o se archiva al paciente (DX-461).
 */

const DAY = 24 * 60 * 60_000;

/** Ruta pública de la web (`/certificado/copia/<token>`). */
export const CERTIFICATE_COPY_PUBLIC_PATH = '/certificado/copia';

export const CERTIFICATE_COPY_CONFIG = Symbol('CERTIFICATE_COPY_CONFIG');

export interface CertificateCopyConfig {
  ttlDays: number;
}

export const CERTIFICATE_COPY_DEFAULT_TTL_DAYS = 30;
const TTL_ENV = 'CERTIFICATE_COPY_LINK_TTL_DAYS';
const MAX_TTL_DAYS = 90;

/** Lee la caducidad del entorno; un valor inválido hace fallar el arranque. */
export function loadCertificateCopyConfig(
  get: (key: string) => string | undefined,
): CertificateCopyConfig {
  const raw = get(TTL_ENV)?.trim();
  if (raw === undefined || raw === '') {
    return { ttlDays: CERTIFICATE_COPY_DEFAULT_TTL_DAYS };
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > MAX_TTL_DAYS) {
    throw new Error(
      `${TTL_ENV} tiene que ser un entero entre 1 y ${MAX_TTL_DAYS} (días que vale el enlace de la copia del certificado).`,
    );
  }
  return { ttlDays: value };
}

export function certificateCopyExpiresAt(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + ttlDays * DAY);
}

export function buildCertificateCopyUrl(base: string, token: string): string {
  return `${base}${CERTIFICATE_COPY_PUBLIC_PATH}/${token}`;
}

export type CertificateCopyLinkState = 'AVAILABLE' | 'EXPIRED' | 'GONE';

export function certificateCopyLinkState(
  link: { expiresAt: Date; revokedAt: Date | null },
  now: Date,
): CertificateCopyLinkState {
  if (link.revokedAt !== null) return 'GONE';
  if (link.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'AVAILABLE';
}

export const CERTIFICATE_COPY_NOT_FOUND_MESSAGE =
  'El enlace no existe o ya no es válido.';
export const CERTIFICATE_COPY_EXPIRED_MESSAGE =
  'Este enlace caducó. Si necesitas otra copia del certificado, pídesela a la clínica.';
export const CERTIFICATE_COPY_EXPIRED_CODE = 'CERTIFICATE_COPY_LINK_EXPIRED';
export const CERTIFICATE_COPY_VOIDED_MESSAGE =
  'El certificado está anulado: no se envía al paciente.';
export const CERTIFICATE_COPY_NO_LINK_HOST_MESSAGE =
  'No se pudo armar el enlace de la clínica: revisa su subdominio.';

/** Motivos de auditoría. */
export const CERTIFICATE_COPY_SENT_REASON = 'CERTIFICATE_COPY_SENT';
export const CERTIFICATE_COPY_OPENED_REASON = 'CERTIFICATE_COPY_OPENED';
export const CERTIFICATE_COPY_DOWNLOADED_REASON = 'CERTIFICATE_COPY_DOWNLOADED';

/**
 * El destinatario lo resuelve el mismo criterio que la copia de la receta
 * (DX-468: baja de envíos, menor por su responsable que recibe avisos); sus
 * mensajes hablan de la receta, así que se dicen aquí para el certificado.
 */
const RECIPIENT_MESSAGES: Record<string, string> = {
  [PRESCRIPTION_COPY_OPTED_OUT_MESSAGE]:
    'El paciente dio de baja los envíos: entrégale el certificado impreso.',
  [PRESCRIPTION_COPY_NO_WHATSAPP_MESSAGE]:
    'El paciente no tiene un teléfono que sirva para WhatsApp: escríbelo en su ficha con + y su prefijo, o entrégale el certificado impreso.',
  [PRESCRIPTION_COPY_MINOR_NO_WHATSAPP_MESSAGE]:
    'El paciente es menor de edad: registra en su ficha un responsable que reciba avisos y tenga un teléfono para WhatsApp.',
};

export function certificateRecipientMessage(reason: string): string {
  return RECIPIENT_MESSAGES[reason] ?? reason;
}

type Language = 'es' | 'en';

const WHAT: Record<Language, Record<CertificateKind, string>> = {
  es: {
    ATTENDANCE: 'el justificante de asistencia',
    REST: 'el certificado de reposo',
  },
  en: {
    ATTENDANCE: 'the attendance certificate',
    REST: 'the medical rest certificate',
  },
};

/**
 * Mensaje prellenado de WhatsApp en el idioma del paciente (DX-497): la
 * clínica, qué documento, la caducidad y el enlace. Nada clínico.
 */
export function certificateWhatsAppText(input: {
  language: string;
  kind: CertificateKind;
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
    return `${greeting}, this is ${input.clinic}. Here is ${what}${whose} (personal link, expires on ${input.expiresAtLabel}): ${input.url}`;
  }
  const greeting = input.name ? `Hola ${input.name}` : 'Hola';
  const whose = input.patient ? ` de ${input.patient}` : '';
  return `${greeting}, le saludamos de ${input.clinic}. Aquí tiene ${what}${whose} (enlace personal, caduca el ${input.expiresAtLabel}): ${input.url}`;
}
