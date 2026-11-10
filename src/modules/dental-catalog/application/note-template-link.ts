import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CatalogKind } from '@prisma/client';
import type { CatalogNoteTemplateReader } from '../domain/ports/catalog-note-template-reader.port';

export const LINK_TEMPLATE_NOT_FOUND_MESSAGE =
  'Plantilla de evolución no encontrada en esta clínica';

export const LINK_TEMPLATE_DIAGNOSIS_MESSAGE =
  'Solo un procedimiento puede llevar plantilla de evolución: un diagnóstico no se marca como hecho.';

export function inactiveLinkTemplateMessage(name: string): string {
  return `La plantilla «${name}» está desactivada: actívala en Ajustes → Plantillas de evolución o elige otra.`;
}

/**
 * DX-455: comprueba la plantilla que se quiere ligar al ítem del catálogo
 * (`kind` = el tipo que tendrá el ítem). Bajo RLS: una de otra clínica es
 * indistinguible de una inexistente (404). Desactivada: 400. Diagnóstico con
 * plantilla: 400. `null` (quitar el vínculo) siempre vale.
 */
export async function assertLinkableNoteTemplate(
  reader: CatalogNoteTemplateReader,
  templateId: string | null | undefined,
  kind: CatalogKind,
): Promise<void> {
  if (templateId === undefined || templateId === null) return;
  if (kind !== CatalogKind.PROCEDURE) {
    throw new BadRequestException(LINK_TEMPLATE_DIAGNOSIS_MESSAGE);
  }
  const template = await reader.find(templateId);
  if (!template) throw new NotFoundException(LINK_TEMPLATE_NOT_FOUND_MESSAGE);
  if (!template.active) {
    throw new BadRequestException(inactiveLinkTemplateMessage(template.name));
  }
}
