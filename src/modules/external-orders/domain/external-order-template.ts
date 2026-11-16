import type { ConfigSnapshot } from '../../audit/domain/config-audit';
import {
  EXTERNAL_ORDER_KINDS,
  ITEMS_MAX,
  ITEM_MAX_LENGTH,
  RECIPIENT_MAX_LENGTH,
  normalizeLines,
  normalizeText,
  type ExternalOrderKind,
} from './external-order-rules';

/**
 * DX-572 (D7): plantilla de orden externa de la clínica. Tipo, destinatario
 * habitual opcional y estudios. No se borra: se desactiva. Versión optimista
 * como DX-559. Sin semilla de ningún país.
 */
export interface ExternalOrderTemplate {
  id: string;
  name: string;
  kind: ExternalOrderKind;
  recipient: string | null;
  items: string[];
  active: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const TEMPLATE_NAME_MAX_LENGTH = 80;

export interface ExternalOrderTemplateDraft {
  name: string;
  kind: ExternalOrderKind;
  recipient: string | null;
  items: string[];
  active: boolean;
}

export type TemplateCheck =
  | { ok: true; value: ExternalOrderTemplateDraft }
  | { ok: false; errors: string[] };

/** Valida la plantilla completa y dice TODO lo que falta (un 400). */
export function checkExternalOrderTemplate(input: {
  name: unknown;
  kind: unknown;
  recipient: unknown;
  items: unknown;
  active: unknown;
}): TemplateCheck {
  const errors: string[] = [];
  const name = normalizeText(input.name, TEMPLATE_NAME_MAX_LENGTH);
  if (name === null) {
    errors.push(
      `el nombre tiene que tener entre 1 y ${TEMPLATE_NAME_MAX_LENGTH} caracteres`,
    );
  }
  const kind = EXTERNAL_ORDER_KINDS.includes(input.kind as ExternalOrderKind)
    ? (input.kind as ExternalOrderKind)
    : null;
  if (kind === null) errors.push('el tipo es IMAGING, LAB, SPECIALIST u OTHER');
  let recipient: string | null = null;
  if (
    input.recipient !== undefined &&
    input.recipient !== null &&
    !(typeof input.recipient === 'string' && input.recipient.trim() === '')
  ) {
    recipient = normalizeText(input.recipient, RECIPIENT_MAX_LENGTH);
    if (recipient === null) {
      errors.push(
        `el destinatario habitual admite hasta ${RECIPIENT_MAX_LENGTH} caracteres`,
      );
    }
  }
  const items = normalizeLines(input.items, ITEMS_MAX, ITEM_MAX_LENGTH);
  if (items === null) {
    errors.push(
      `indica de 1 a ${ITEMS_MAX} estudios o motivos, de hasta ${ITEM_MAX_LENGTH} caracteres cada uno`,
    );
  }
  if (typeof input.active !== 'boolean') {
    errors.push('indica si la plantilla está activa');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: (name as string).replace(/\s+/g, ' '),
      kind: kind as ExternalOrderKind,
      recipient,
      items: items as string[],
      active: input.active as boolean,
    },
  };
}

export function templateErrorMessage(errors: readonly string[]): string {
  return `La plantilla no es válida: ${errors.join('; ')}.`;
}

/** Clave para el «nombre único» sin mayúsculas ni espacios repetidos. */
export function templateNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
}

/**
 * D11: de una plantilla la auditoría guarda el nombre, el tipo, si está
 * activa y cuántos estudios tiene. El destinatario y los estudios solo por su
 * nombre de campo (`changedFields`): son el contenido.
 */
export const TEMPLATE_HIDDEN_FIELDS = ['recipient', 'items'] as const;

export function externalOrderTemplateSnapshot(
  template: Pick<
    ExternalOrderTemplate,
    'name' | 'kind' | 'recipient' | 'items' | 'active'
  >,
): ConfigSnapshot {
  return {
    name: template.name,
    kind: template.kind,
    active: template.active,
    itemCount: template.items.length,
    recipient: template.recipient ?? '',
    items: JSON.stringify(template.items),
  };
}

export const TEMPLATE_STALE_CODE = 'EXTERNAL_ORDER_TEMPLATE_STALE';
export const TEMPLATE_DUPLICATE_CODE = 'EXTERNAL_ORDER_TEMPLATE_DUPLICATE_NAME';
export const TEMPLATE_NOT_FOUND_MESSAGE =
  'Plantilla de orden no encontrada en esta clínica.';
export const TEMPLATE_STALE_MESSAGE =
  'La plantilla cambió mientras la editabas: recárgala.';
export const TEMPLATE_DUPLICATE_MESSAGE =
  'Ya existe una plantilla de orden con ese nombre.';
