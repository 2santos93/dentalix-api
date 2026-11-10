/**
 * DX-455: la plantilla de evolución que se quiere ligar a un procedimiento,
 * leída bajo la RLS de la clínica: `null` si no existe o es de otra clínica
 * (indistinguibles, como en el resto de la API).
 */
export interface CatalogNoteTemplateReader {
  find(
    id: string,
  ): Promise<{ id: string; name: string; active: boolean } | null>;
}

export const CATALOG_NOTE_TEMPLATE_READER = Symbol(
  'CATALOG_NOTE_TEMPLATE_READER',
);
