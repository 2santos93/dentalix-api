import type { ContactChannel } from '@prisma/client';
import { firstNameOnly } from '../../appointment-confirmations/application/confirmation-token';
import { isMinor } from '../../patients/domain/responsible-parties/majority-age';
import { maskEmail } from '../../../shared/privacy/mask-email';
import {
  whatsAppDigits,
  type PhoneRegion,
} from '../../../shared/phone/phone-number';
import {
  maskPhoneDigits,
  type PrescriptionCopyChannel,
} from './prescription-copy-link';

export const PRESCRIPTION_COPY_OPTED_OUT_MESSAGE =
  'El paciente dio de baja los envíos: entrégale la receta impresa.';
export const PRESCRIPTION_COPY_NO_EMAIL_MESSAGE =
  'El paciente no tiene email: añádelo en su ficha o envíala por WhatsApp.';
export const PRESCRIPTION_COPY_NO_WHATSAPP_MESSAGE =
  'El paciente no tiene un teléfono que sirva para WhatsApp: escríbelo con + y su prefijo, o envíala por email.';
export const PRESCRIPTION_COPY_MINOR_NO_EMAIL_MESSAGE =
  'El paciente es menor de edad: registra en su ficha un responsable que reciba avisos y tenga email.';
export const PRESCRIPTION_COPY_MINOR_NO_WHATSAPP_MESSAGE =
  'El paciente es menor de edad: registra en su ficha un responsable que reciba avisos y tenga un teléfono para WhatsApp.';

/** Un responsable VIVO del paciente (DX-203), con su email y su teléfono. */
export interface PrescriptionCopyResponsible {
  id: string;
  /** Nombre completo (del contacto o de la ficha del paciente responsable). */
  name: string;
  email: string | null;
  phone: string | null;
  isPayer: boolean;
  receivesNotices: boolean;
}

export interface PrescriptionCopyRecipientInput {
  channel: PrescriptionCopyChannel;
  patient: {
    firstName: string;
    birthDate: Date | null;
    email: string | null;
    phone: string | null;
    reminderOptOutAt: Date | null;
    contactChannel: ContactChannel;
  };
  /** Responsables vivos, en orden de alta. */
  responsibles: readonly PrescriptionCopyResponsible[];
  /** Mayoría de edad de la clínica (DX-328). */
  majorityAge: number;
  /** Día civil (YYYY-MM-DD) de la sede de la receta. */
  today: string;
  /** Región telefónica de la sede de la receta (números sin prefijo). */
  phoneRegion: PhoneRegion | null;
}

export type PrescriptionCopyRecipient =
  | {
      ok: true;
      kind: 'PATIENT' | 'RESPONSIBLE';
      /** Email o dígitos E.164 sin «+» (para `wa.me`), según el canal. */
      destination: string;
      /** Lo que la ficha muestra («a***@…», «••• 4567»). */
      destinationMasked: string;
      /** Nombre de pila con el que se saluda. */
      greetingName: string | null;
      /** Responsable de un menor: el nombre de pila del paciente. */
      patientFirstName: string | null;
      responsiblePartyId: string | null;
    }
  | { ok: false; reason: string };

const clean = (value: string | null): string | null => value?.trim() || null;

function contactOf(
  channel: PrescriptionCopyChannel,
  holder: { email: string | null; phone: string | null },
  region: PhoneRegion | null,
): { destination: string; masked: string } | null {
  if (channel === 'EMAIL') {
    const email = clean(holder.email);
    return email ? { destination: email, masked: maskEmail(email) } : null;
  }
  const digits = whatsAppDigits(holder.phone, region);
  return digits
    ? { destination: digits, masked: maskPhoneDigits(digits) }
    : null;
}

/**
 * A quién va la copia de la receta (DX-468), con el mismo criterio que la
 * firma a distancia (DX-243) y la copia del PDF firmado (DX-443): un adulto
 * la recibe en SU email o SU teléfono. Un menor (mayoría de edad de la
 * clínica en el día civil de la sede, DX-328), por su responsable registrado
 * que recibe avisos (DX-203; primero el pagador y luego por orden de alta)
 * con el contacto del canal; nunca el contacto de la ficha del menor (podría
 * ser el del propio menor). La baja de los envíos (DX-128) lo impide siempre.
 */
export function resolvePrescriptionCopyRecipient(
  input: PrescriptionCopyRecipientInput,
): PrescriptionCopyRecipient {
  const { patient, channel } = input;
  if (patient.reminderOptOutAt !== null || patient.contactChannel === 'NONE') {
    return { ok: false, reason: PRESCRIPTION_COPY_OPTED_OUT_MESSAGE };
  }
  const minor = isMinor(patient.birthDate, input.majorityAge, input.today);
  if (!minor) {
    const own = contactOf(channel, patient, input.phoneRegion);
    if (!own) {
      return {
        ok: false,
        reason:
          channel === 'EMAIL'
            ? PRESCRIPTION_COPY_NO_EMAIL_MESSAGE
            : PRESCRIPTION_COPY_NO_WHATSAPP_MESSAGE,
      };
    }
    return {
      ok: true,
      kind: 'PATIENT',
      destination: own.destination,
      destinationMasked: own.masked,
      greetingName: firstNameOnly(patient.firstName),
      patientFirstName: null,
      responsiblePartyId: null,
    };
  }
  // Orden estable: pagador primero; entre iguales, el de alta más antigua.
  const candidates = input.responsibles
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => r.receivesNotices)
    .sort(
      (a, b) => Number(b.r.isPayer) - Number(a.r.isPayer) || a.index - b.index,
    )
    .map(({ r }) => r);
  for (const responsible of candidates) {
    const contact = contactOf(channel, responsible, input.phoneRegion);
    if (contact) {
      return {
        ok: true,
        kind: 'RESPONSIBLE',
        destination: contact.destination,
        destinationMasked: contact.masked,
        greetingName: firstNameOnly(responsible.name),
        patientFirstName: firstNameOnly(patient.firstName),
        responsiblePartyId: responsible.id,
      };
    }
  }
  return {
    ok: false,
    reason:
      channel === 'EMAIL'
        ? PRESCRIPTION_COPY_MINOR_NO_EMAIL_MESSAGE
        : PRESCRIPTION_COPY_MINOR_NO_WHATSAPP_MESSAGE,
  };
}
