import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { PreparedEmail } from '../../../notifications/email/application/email-outbox.service';
import type {
  MessageChannel,
  MessageKey,
  MessageLanguage,
  MessageText,
} from '../message-catalog';

export const MESSAGE_TEMPLATE_REPOSITORY = Symbol(
  'MESSAGE_TEMPLATE_REPOSITORY',
);

/** Una fila guardada de `message_templates` (de la clínica del contexto). */
export interface StoredMessageTemplate extends MessageText {
  id: string;
  key: string;
  channel: string;
  language: string;
  updatedAt: Date;
  updatedByName: string | null;
}

export interface MessageTemplateId {
  key: MessageKey;
  channel: MessageChannel;
  language: MessageLanguage;
}

/** Quien pide la prueba: su correo y si está confirmado. */
export interface MessageTestRecipient {
  email: string;
  verified: boolean;
}

/**
 * DX-565: textos de la clínica del contexto (RLS). Guardar y restablecer
 * escriben su evento de auditoría (CLINIC_SETTINGS) en la MISMA transacción.
 */
export interface MessageTemplateRepository {
  list(): Promise<StoredMessageTemplate[]>;
  find(id: MessageTemplateId): Promise<MessageText | null>;
  /** Ajustes › Idiomas de los pacientes (`tenants.patientLanguages`). */
  patientLanguages(): Promise<string[]>;
  clinicName(): Promise<string | null>;
  /** Crea o cambia el texto; sin cambios, no escribe nada (ni evento). */
  save(
    id: MessageTemplateId,
    text: MessageText,
    ctx: AuditRequestContext,
  ): Promise<StoredMessageTemplate>;
  /** Borra la fila (vuelve al texto del código). `false` si no había. */
  reset(id: MessageTemplateId, ctx: AuditRequestContext): Promise<boolean>;
  testRecipient(userId: string): Promise<MessageTestRecipient | null>;
  /** Segundos que faltan para otra prueba de esta persona (0 = puede). */
  testCooldownRemaining(
    userId: string,
    cooldownSeconds: number,
  ): Promise<number>;
  /**
   * Encola la prueba y su evento en UNA transacción, con la espera vuelta a
   * contar bajo candado (dos clics seguidos no envían dos).
   */
  recordTestSend(
    email: PreparedEmail,
    id: MessageTemplateId,
    /** El borrador del editor (true) o lo guardado / el texto por defecto. */
    draft: boolean,
    ctx: AuditRequestContext,
    cooldownSeconds: number,
  ): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }>;
}
