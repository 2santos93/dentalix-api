import { Logger } from '@nestjs/common';
import type {
  MessageChannel,
  MessageKey,
  MessageLanguage,
  MessageText,
} from './message-catalog';
import { renderMessageTemplate } from './message-template-engine';
import type { MessageValues } from './message-variables';

const logger = new Logger('MessageTemplates');

/**
 * DX-565: el texto de la clínica renderizado para un envío, o `null` = sale
 * el texto por defecto. Si había texto guardado y no sale (ya no es válido,
 * armaría un enlace o se pasa de largo), lo deja en el log: la clave, el
 * canal, el idioma y el motivo, nunca datos del paciente.
 */
export function renderClinicText(
  key: MessageKey,
  channel: MessageChannel,
  language: MessageLanguage,
  override: MessageText | null | undefined,
  values: MessageValues,
): MessageText | null {
  if (!override) return null;
  const rendered = renderMessageTemplate(
    key,
    channel,
    language,
    override,
    values,
  );
  if (rendered.ok) return rendered.text;
  logger.warn({
    event: 'message_templates.fallback_to_default',
    key,
    channel,
    language,
    reason: rendered.reason,
  });
  return null;
}
