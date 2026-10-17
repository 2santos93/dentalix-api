import type { ContactChannel } from '@prisma/client';
import { civilDateIn } from '../../../shared/time/civil-day';
import { normalizeMobile } from '../../patients/domain/communication/mobile-number';

/** Reglas y textos de las ofertas de huecos libres (DX-210). */

export const WAITLIST_OFFER_CONFIG = Symbol('WAITLIST_OFFER_CONFIG');

export interface WaitlistOfferConfig {
  /** Ofertas por paciente y día civil (zona de la sede). */
  offersPerPatientPerDay: number;
}

export const DEFAULT_WAITLIST_OFFER_CONFIG: WaitlistOfferConfig = {
  offersPerPatientPerDay: 2,
};

const CAP_ENV = 'WAITLIST_OFFERS_PER_PATIENT_PER_DAY';
const MAX_CAP = 20;

/** Lee el tope del entorno; un valor inválido hace fallar el arranque. */
export function loadWaitlistOfferConfig(
  get: (key: string) => string | undefined,
): WaitlistOfferConfig {
  const raw = get(CAP_ENV)?.trim();
  if (raw === undefined || raw === '') return DEFAULT_WAITLIST_OFFER_CONFIG;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > MAX_CAP) {
    throw new Error(
      `${CAP_ENV} tiene que ser un entero entre 1 y ${MAX_CAP} (ofertas por paciente y día).`,
    );
  }
  return { offersPerPatientPerDay: value };
}

/** 409 al pasarse del tope: «Ya se le ofrecieron 2 huecos hoy». */
export function offerCapMessage(cap: number): string {
  return cap === 1
    ? 'Ya se le ofreció 1 hueco hoy'
    : `Ya se le ofrecieron ${cap} huecos hoy`;
}

export const OFFER_SLOT_PAST_MESSAGE = 'Este hueco ya pasó';
export const OFFER_SLOT_INVALID_MESSAGE =
  'El hueco tiene que terminar después de empezar y durar como mucho 8 horas';
export const OFFER_WHATSAPP_BLOCKED_MESSAGE =
  'Este paciente no recibe WhatsApp de la clínica (se dio de baja o no quiere avisos). Llámalo.';
export const OFFER_WHATSAPP_NO_OPT_IN_MESSAGE =
  'Este paciente no ha dado permiso para escribirle por WhatsApp. Llámalo.';
export const OFFER_WHATSAPP_NO_MOBILE_MESSAGE =
  'Este paciente no tiene un móvil válido para WhatsApp. Llámalo o corrige su número.';
export const OFFER_WHATSAPP_OUTCOME_MESSAGE =
  'Una oferta por WhatsApp nace pendiente: anota la respuesta del paciente después.';
export const OFFER_NOT_FOUND_MESSAGE = 'Oferta no encontrada';
export const OFFER_ALREADY_RESOLVED_MESSAGE =
  'Esta oferta ya tiene resultado anotado.';
export const OFFER_ENTRY_MISMATCH_MESSAGE =
  'Este pendiente ya no está en la lista o es de otro paciente o sede.';
export const OFFER_APPOINTMENT_MISMATCH_MESSAGE =
  'Esta cita ya no está para adelantar o es de otro paciente o sede.';
export const DENTIST_OWN_COLUMN_MESSAGE =
  'Solo puedes ver los candidatos de los huecos de tu propia agenda';

/** Día civil (YYYY-MM-DD) de la oferta en la zona de la sede. */
export function offerDayFor(now: Date, timeZone: string): string {
  return civilDateIn(now, timeZone);
}

export interface PatientContactFields {
  phone: string | null;
  contactChannel: ContactChannel;
  reminderOptOutAt: Date | null;
  /** DX-128: cuándo dio el permiso de WhatsApp (con su origen); `null` = no lo dio. */
  whatsappOptInAt: Date | null;
}

/** Por qué no se le escribe por WhatsApp (DX-128). */
export type WhatsappOfferBlock = 'OPTED_OUT' | 'CHANNEL_NONE' | 'NO_OPT_IN';

/**
 * ¿Se le puede ofrecer el hueco por WhatsApp? (DX-128, Ley 1581 / RGPD:
 * minimización y finalidad) Con la baja de los avisos o el canal «Ninguno»,
 * no: el paciente pidió que no le escriban. Tampoco sin el permiso de WhatsApp
 * registrado (fecha y origen): escribirle por un canal que no autorizó no es
 * un aviso operativo de su cita, es ofrecerle algo nuevo. En los tres casos se
 * le llama. Si no, hace falta un móvil válido (E.164 sin `+`, como
 * `wa.me/<número>`).
 */
export function whatsappOfferPhone(
  patient: PatientContactFields,
  countryCode: string | null,
): {
  blocked: boolean;
  reason: WhatsappOfferBlock | null;
  phone: string | null;
} {
  const reason: WhatsappOfferBlock | null =
    patient.reminderOptOutAt !== null
      ? 'OPTED_OUT'
      : patient.contactChannel === 'NONE'
        ? 'CHANNEL_NONE'
        : patient.whatsappOptInAt === null
          ? 'NO_OPT_IN'
          : null;
  if (reason) return { blocked: true, reason, phone: null };
  const mobile = normalizeMobile(patient.phone, countryCode);
  return { blocked: false, reason: null, phone: mobile.e164?.slice(1) ?? null };
}

/** 403 de ofrecer y asignar huecos (DENTIST y ASSISTANT). */
export const OPENING_ASSIGN_FORBIDDEN_MESSAGE =
  'Solo recepción y la administración ofrecen y asignan huecos libres';
/** 403 de ver candidatos (ASSISTANT). */
export const OPENING_CANDIDATES_FORBIDDEN_MESSAGE =
  'Solo recepción, los odontólogos y la administración ven los candidatos de un hueco';
