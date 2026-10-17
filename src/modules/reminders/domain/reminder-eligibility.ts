import type { ContactChannel } from '@prisma/client';

/** Lo que decide si un paciente recibe el recordatorio automático por email. */
export interface ReminderContact {
  contactChannel: ContactChannel;
  reminderOptOutAt: Date | null;
  email: string | null;
}

export type ReminderContactBlocker =
  'OPTED_OUT' | 'CHANNEL_NONE' | 'CHANNEL_WHATSAPP' | 'NO_EMAIL';

/**
 * Regla de elegibilidad del recordatorio automático por EMAIL (DX-128):
 *
 * 1. Con una baja registrada (`reminderOptOutAt`, por enlace, por mensaje o
 *    anotada por recepción) no sale NINGÚN envío automático, sea cual sea el
 *    canal: la baja se respeta en todos los envíos automáticos.
 * 2. Canal NONE: nada automático.
 * 3. Canal WHATSAPP: no se manda el email automático. El envío por WhatsApp
 *    llegará con DX-126 (exigirá el opt-in de WhatsApp y un móvil válido);
 *    mientras tanto recepción sigue teniendo el botón wa.me manual.
 * 4. Canal EMAIL sin email: no hay a quién mandarlo.
 *
 * `null` = se envía. El barrido (PrismaReminderRepository.dueCandidates)
 * aplica 1–3 en SQL, así que esos pacientes ni siquiera entran en la cola; el
 * handler la vuelve a aplicar entera al ejecutarse (la baja pudo llegar entre
 * el encolado y la hora del envío).
 */
export function emailReminderBlocker(
  contact: ReminderContact,
): ReminderContactBlocker | null {
  if (contact.reminderOptOutAt) return 'OPTED_OUT';
  if (contact.contactChannel === 'NONE') return 'CHANNEL_NONE';
  if (contact.contactChannel === 'WHATSAPP') return 'CHANNEL_WHATSAPP';
  if (!contact.email?.trim()) return 'NO_EMAIL';
  return null;
}
