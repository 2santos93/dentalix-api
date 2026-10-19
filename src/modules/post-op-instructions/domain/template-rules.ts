const CODE_PATTERN = /^[A-Z0-9-]{2,20}$/;

/** Mensaje de error del código de plantilla, o null si es válido. */
export function templateCodeError(code: string): string | null {
  return CODE_PATTERN.test(code)
    ? null
    : 'El código admite de 2 a 20 letras mayúsculas, números o guiones.';
}

export function normalizeTemplateCode(code: string): string {
  return code.trim().toUpperCase();
}

/** ¿La edición cambia el texto (título o cuerpo) respecto a lo guardado? */
export function textChanged(
  before: { title: string; body: string },
  after: { title?: string; body?: string },
): boolean {
  return (
    (after.title !== undefined && after.title !== before.title) ||
    (after.body !== undefined && after.body !== before.body)
  );
}

export interface SuggestableTemplate {
  id: string;
  active: boolean;
  links: Array<{
    catalogItemId: string | null;
    appointmentTypeId: string | null;
  }>;
}

/**
 * Separa las plantillas activas en sugeridas (algún vínculo coincide con el
 * tipo de cita o con un ítem de catálogo realizado) y el resto. Conserva el
 * orden de entrada en ambos grupos.
 */
export function suggestTemplates(input: {
  templates: SuggestableTemplate[];
  appointmentTypeId: string | null;
  performedCatalogItemIds: string[];
}): { suggested: string[]; others: string[] } {
  const performed = new Set(input.performedCatalogItemIds);
  const suggested: string[] = [];
  const others: string[] = [];
  for (const template of input.templates) {
    if (!template.active) continue;
    const matches = template.links.some(
      (link) =>
        (link.appointmentTypeId !== null &&
          link.appointmentTypeId === input.appointmentTypeId) ||
        (link.catalogItemId !== null && performed.has(link.catalogItemId)),
    );
    (matches ? suggested : others).push(template.id);
  }
  return { suggested, others };
}
