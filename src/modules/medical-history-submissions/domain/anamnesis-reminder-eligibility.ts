import {
  anamnesisStatus,
  type AnamnesisStatus,
} from '../../medical-history/domain/anamnesis-validity';

/**
 * DX-290: ¿lleva el recordatorio (o el mensaje de confirmación por WhatsApp)
 * el enlace de anamnesis?
 *
 * Criterio, en este orden:
 * 1. La sede tiene encendido «Enviar la anamnesis con el recordatorio»
 *    (`location_reminder_settings.sendAnamnesis`, apagado por defecto).
 * 2. El paciente no está archivado (DX-461: un archivado no tiene enlaces
 *    vivos; el alta del enlace lo vuelve a exigir con el paciente bloqueado).
 * 3. No hay respuestas suyas esperando revisión (SUBMITTED): ya la rellenó y
 *    falta que la clínica la acepte; otro enlace solo le haría repetirla.
 * 4. La anamnesis está `MISSING` (paciente nuevo: nunca se registró una
 *    versión) o `EXPIRED` (DX-247: pasaron `tenants.anamnesisValidityMonths`
 *    meses, 12 por defecto, desde la última versión o la última confirmación
 *    «Sin cambios hoy»), evaluada el DÍA CIVIL DE LA CITA en la zona de su
 *    sede, como la agenda: preparar la visita del jueves mira lo que valdrá
 *    el jueves. `CURRENT` no lleva enlace.
 * 5. Si el paciente no dio aún la autorización SENSITIVE_HEALTH, la clínica
 *    tiene publicada su política de datos (el formulario la pide antes, como
 *    en DX-099); sin política no hay qué pedirle y no se emite.
 *
 * Un enlace PENDIENTE no impide emitir otro: el token solo existe como hash
 * (no se puede reenviar el mismo), así que el nuevo ANULA el anterior en la
 * misma transacción (un solo enlace vivo por paciente, como DX-099).
 */
export type AnamnesisReminderSkip =
  | 'DISABLED'
  /** La cita no existe, ya empezó o no está agendada/confirmada (solo el panel). */
  | 'NOT_SCHEDULABLE'
  /** La sede no tiene zona horaria: no se puede saber el día de la cita. */
  | 'NO_TIME_ZONE'
  | 'ARCHIVED'
  | 'AWAITING_REVIEW'
  | 'CURRENT'
  | 'NO_POLICY';

export interface AnamnesisReminderFacts {
  settingEnabled: boolean;
  patientArchived: boolean;
  /** Hay un envío del paciente en SUBMITTED (respondido, sin revisar). */
  awaitingReview: boolean;
  /** Última versión o confirmación «Sin cambios hoy»; null = nunca. */
  lastReviewedAt: Date | null;
  validityMonths: number;
  /** Día civil (YYYY-MM-DD) de la cita en la zona de su sede. */
  appointmentDay: string;
  timeZone: string;
  sensitiveHealthGranted: boolean;
  hasPrivacyPolicy: boolean;
}

export type AnamnesisReminderDecision =
  | { send: true; status: Exclude<AnamnesisStatus, 'CURRENT'> }
  | { send: false; reason: AnamnesisReminderSkip };

export function decideAnamnesisWithReminder(
  facts: AnamnesisReminderFacts,
): AnamnesisReminderDecision {
  if (!facts.settingEnabled) return { send: false, reason: 'DISABLED' };
  if (facts.patientArchived) return { send: false, reason: 'ARCHIVED' };
  if (facts.awaitingReview) return { send: false, reason: 'AWAITING_REVIEW' };
  const status = anamnesisStatus(
    facts.lastReviewedAt,
    facts.validityMonths,
    facts.appointmentDay,
    facts.timeZone,
  );
  if (status === 'CURRENT') return { send: false, reason: 'CURRENT' };
  if (!facts.sensitiveHealthGranted && !facts.hasPrivacyPolicy) {
    return { send: false, reason: 'NO_POLICY' };
  }
  return { send: true, status };
}

/** Motivo de la auditoría del enlace que crea el recordatorio (origen JOB). */
export const ANAMNESIS_LINK_SENT_WITH_REMINDER_REASON =
  'ANAMNESIS_LINK_SENT_WITH_REMINDER';
