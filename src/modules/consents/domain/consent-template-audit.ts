import type { ConfigSnapshot } from '../../audit/domain/config-audit';
import type { ConsentTemplate } from './entities/consent-template.entity';

/**
 * DX-360: el texto de la plantilla solo figura por su nombre de campo
 * (`changedFields`): es largo y lo identifica la `version`, que sube con
 * cada cambio de título o texto.
 */
export const CONSENT_TEMPLATE_HIDDEN_FIELDS = ['body'] as const;

export function consentTemplateSnapshot(
  template: ConsentTemplate,
): ConfigSnapshot {
  return {
    title: template.title,
    body: template.body,
    active: template.active,
    version: template.version,
  };
}
