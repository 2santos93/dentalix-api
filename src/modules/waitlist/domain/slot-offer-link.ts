import { createHash, randomBytes } from 'node:crypto';
import type {
  ContactChannel,
  WaitlistOfferChannel,
  WaitlistOfferOutcome,
} from '@prisma/client';

/**
 * DX-435: oferta de un hueco libre con enlace público. Recepción la envía a
 * varios candidatos (email o `wa.me`); el primero que acepta se queda la cita
 * y las demás ofertas del hueco pasan a TAKEN_BY_OTHER.
 */

const MINUTE = 60_000;
const TOKEN_BYTES = 32;
// 32 bytes en base64url sin relleno = 43 caracteres URL-safe.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Ruta pública de la web (`/hueco/<token>`). */
export const SLOT_OFFER_PUBLIC_PATH = '/hueco';

/** Con menos de esto para el hueco no da tiempo a verlo y llegar. */
export const LINK_OFFER_MIN_LEAD_MINUTES = 20;

export const LINK_OFFER_CONFIG = Symbol('LINK_OFFER_CONFIG');

export interface LinkOfferConfig {
  /** Minutos antes del inicio del hueco en que caduca el enlace (0 = al empezar). */
  expiryLeadMinutes: number;
}

const LEAD_ENV = 'WAITLIST_LINK_OFFER_EXPIRY_LEAD_MINUTES';
const MAX_LEAD = 1440;

/** Lee la antelación del entorno; un valor inválido hace fallar el arranque. */
export function loadLinkOfferConfig(
  get: (key: string) => string | undefined,
): LinkOfferConfig {
  const raw = get(LEAD_ENV)?.trim();
  if (raw === undefined || raw === '') return { expiryLeadMinutes: 0 };
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value > MAX_LEAD) {
    throw new Error(
      `${LEAD_ENV} tiene que ser un entero entre 0 y ${MAX_LEAD} (minutos antes del hueco en que caduca el enlace).`,
    );
  }
  return { expiryLeadMinutes: value };
}

/** Token del enlace en texto plano: viaja SOLO en la URL, nunca se guarda. */
export function generateSlotOfferToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Hash estable del token, para guardar y buscar sin el texto plano. */
export function hashSlotOfferToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Descarta en el acto lo que no puede ser un token (enumeración, enlaces truncados). */
export function isWellFormedSlotOfferToken(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

export function buildSlotOfferUrl(
  protocol: string,
  host: string,
  token: string,
): string {
  return `${protocol}://${host}${SLOT_OFFER_PUBLIC_PATH}/${token}`;
}

export const LINK_CHANNELS = ['LINK_WA_ME', 'LINK_EMAIL'] as const;
export type LinkChannel = (typeof LINK_CHANNELS)[number];

export function isLinkChannel(
  channel: WaitlistOfferChannel,
): channel is LinkChannel {
  return (LINK_CHANNELS as readonly string[]).includes(channel);
}

/** ¿Quedan al menos 20 minutos para el hueco? */
export function linkOfferWindowOpen(slotStart: Date, now: Date): boolean {
  return (
    slotStart.getTime() - now.getTime() >= LINK_OFFER_MIN_LEAD_MINUTES * MINUTE
  );
}

/** Caduca al empezar el hueco, o `leadMinutes` antes. */
export function linkOfferExpiresAt(slotStart: Date, leadMinutes: number): Date {
  return new Date(slotStart.getTime() - leadMinutes * MINUTE);
}

/** Lo que ve el paciente al abrir el enlace. */
export type PublicSlotOfferState =
  | 'OPEN'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'EXPIRED'
  /** Otro paciente aceptó antes. */
  | 'TAKEN'
  /** Recepción ocupó o bloqueó el hueco por otra vía. */
  | 'UNAVAILABLE';

export const SLOT_OFFER_MESSAGES: Record<PublicSlotOfferState, string> = {
  OPEN: 'Este hueco está libre para ti',
  ACCEPTED: 'Listo: el hueco es tuyo',
  DECLINED: 'Rechazaste esta oferta',
  // DX-461: caducada, anulada al archivar al paciente o dada por perdida
  // dicen lo mismo (sin pistas de cuál de ellas es).
  EXPIRED: 'Este enlace ya no está disponible',
  TAKEN: 'Este hueco ya se ocupó',
  UNAVAILABLE: 'Este hueco ya no está disponible',
};

/** 404 genérico: token inventado, de otra clínica o mal formado (igual). */
export const SLOT_OFFER_NOT_FOUND_MESSAGE =
  'El enlace no existe o ya no es válido.';

export const LINK_OFFER_TOO_LATE_MESSAGE = `Faltan menos de ${LINK_OFFER_MIN_LEAD_MINUTES} minutos para el hueco: ya no da tiempo a ofrecerlo por enlace. Llama al paciente.`;
export const LINK_OFFER_OUTCOME_MESSAGE =
  'Una oferta con enlace nace pendiente: la responde el paciente desde el enlace.';
export const LINK_OFFER_HOST_MESSAGE =
  'No se pudo armar el enlace de la clínica desde esta dirección.';
export const LINK_OFFER_SLOT_TAKEN_MESSAGE =
  'Este hueco ya está ocupado: ya no se puede ofrecer por enlace.';
export const LINK_OFFER_EMAIL_FAILED_MESSAGE =
  'No pudimos enviar el correo: la oferta quedó sin efecto. Intenta de nuevo en un momento.';
export const OFFER_EMAIL_BLOCKED_MESSAGE =
  'Este paciente no recibe correos de la clínica (se dio de baja o no quiere avisos). Llámalo.';
export const OFFER_EMAIL_MISSING_MESSAGE =
  'Este paciente no tiene correo electrónico. Ofrécelo por WhatsApp o llámalo.';
export const OFFER_LINK_RESOLVED_MESSAGE =
  'Las ofertas con enlace las responde el paciente; si te contestó por otra vía, asígnale el hueco a mano.';

/**
 * Estado público de la oferta. El resultado guardado manda; una PENDING
 * pasada `expiresAt` es EXPIRED aunque nadie la haya marcado (abrir el enlace
 * no escribe nada), y con el hueco ya ocupado por otra vía, UNAVAILABLE.
 * NO_ANSWER (recepción la dio por perdida) se ve como caducada. DX-461: con
 * el paciente archivado, también (defensa en profundidad: archivar ya anula
 * la oferta, pero un archivado anterior pudo dejarla viva).
 */
export function publicSlotOfferState(
  offer: {
    outcome: WaitlistOfferOutcome;
    expiresAt: Date | null;
    patientArchived?: boolean;
  },
  now: Date,
  slotTaken: boolean,
): PublicSlotOfferState {
  if (offer.patientArchived) return 'EXPIRED';
  switch (offer.outcome) {
    case 'ACCEPTED':
      return 'ACCEPTED';
    case 'DECLINED':
      return 'DECLINED';
    case 'TAKEN_BY_OTHER':
      return 'TAKEN';
    case 'EXPIRED':
    case 'NO_ANSWER':
      return 'EXPIRED';
    case 'PENDING':
      if (offer.expiresAt && offer.expiresAt.getTime() <= now.getTime()) {
        return 'EXPIRED';
      }
      return slotTaken ? 'UNAVAILABLE' : 'OPEN';
  }
}

/** Solo una oferta PENDING cambia de resultado, y a uno final. */
export function canResolveOffer(
  from: WaitlistOfferOutcome,
  to: WaitlistOfferOutcome,
): boolean {
  return from === 'PENDING' && to !== 'PENDING';
}

/** Por qué no se le ofrece por email (DX-128). */
export type EmailOfferBlock = 'OPTED_OUT' | 'CHANNEL_NONE' | 'NO_EMAIL';

/**
 * ¿Se le puede escribir el enlace por email? Con la baja de los avisos o el
 * canal «Ninguno», no (DX-128); sin email, tampoco.
 */
export function emailOfferBlock(patient: {
  email: string | null;
  contactChannel: ContactChannel;
  reminderOptOutAt: Date | null;
}): EmailOfferBlock | null {
  if (patient.reminderOptOutAt !== null) return 'OPTED_OUT';
  if (patient.contactChannel === 'NONE') return 'CHANNEL_NONE';
  if (!patient.email?.trim()) return 'NO_EMAIL';
  return null;
}

/** Motivos de auditoría de los eventos del enlace (origen PUBLIC_LINK). */
export const SLOT_OFFER_AUDIT_REASONS = {
  ACCEPTED: 'SLOT_OFFER_ACCEPTED',
  DECLINED: 'SLOT_OFFER_DECLINED',
  EXPIRED: 'SLOT_OFFER_EXPIRED',
  TAKEN_BY_OTHER: 'SLOT_OFFER_TAKEN_BY_OTHER',
} as const;
