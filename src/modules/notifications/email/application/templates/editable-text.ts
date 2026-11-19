import type { MessageText } from '../../../../message-templates/domain/message-catalog';
import {
  messageParagraphs,
  renderMessageTemplate,
} from '../../../../message-templates/domain/message-template-engine';
import type { MessageValues } from '../../../../message-templates/domain/message-variables';
import type { EmailTemplateName } from '../../domain/email-message';
import type { EmailBlock } from './layout';

/**
 * DX-565: las plantillas de email cuyo asunto y cuerpo puede reescribir la
 * clínica (la clave del catálogo de mensajes es el nombre de la plantilla).
 */
export const EDITABLE_EMAIL_TEMPLATES = [
  'appointment-reminder',
  'slot-offer',
  'quote-follow-up',
  'appointment-series',
  'signature-request',
] as const satisfies readonly EmailTemplateName[];
export type EditableEmailTemplate = (typeof EDITABLE_EMAIL_TEMPLATES)[number];

/** La clave del recordatorio, para la plantilla (que no lleva literales: DX-497). */
export const APPOINTMENT_REMINDER_TEMPLATE = EDITABLE_EMAIL_TEMPLATES[0];

export function isEditableEmailTemplate(
  template: EmailTemplateName,
): template is EditableEmailTemplate {
  return (EDITABLE_EMAIL_TEMPLATES as readonly string[]).includes(template);
}

/** El texto de la clínica ya renderizado: el asunto y los párrafos editables. */
export interface CustomEmailText {
  subject: string;
  blocks: EmailBlock[];
}

/**
 * El texto de la clínica para este envío, o `null` = el texto de siempre:
 * sin plantilla guardada, si el envío no es al propio paciente (`values`
 * null: el texto editable habla de «tu cita») o si lo guardado ya no es
 * válido para el catálogo. Cada párrafo conserva sus saltos de línea.
 */
export function customEmailText(
  template: EditableEmailTemplate,
  override: MessageText | null | undefined,
  values: MessageValues | null,
): CustomEmailText | null {
  if (!override || !values) return null;
  const rendered = renderMessageTemplate(template, 'EMAIL', override, values);
  if (!rendered?.subject) return null;
  const blocks = messageParagraphs(rendered.body).map(
    (text): EmailBlock => ({ kind: 'paragraph', text, multiline: true }),
  );
  if (blocks.length === 0) return null;
  return { subject: rendered.subject, blocks };
}

/**
 * «martes 20 de octubre de 2026 a las 9:30 a. m.» → fecha y hora. La etiqueta
 * la escribe SIEMPRE `RegionalFormat.longDateTime` («{día} a las {hora}»):
 * la prueba de este fichero fija ese contrato con el formato real.
 */
export function splitDateTimeLabel(label: string): {
  fecha: string;
  hora: string;
} {
  const at = label.lastIndexOf(' a las ');
  return at === -1
    ? { fecha: label, hora: '' }
    : { fecha: label.slice(0, at), hora: label.slice(at + ' a las '.length) };
}
