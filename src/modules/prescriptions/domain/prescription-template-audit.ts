import type { ConfigSnapshot } from '../../audit/domain/config-audit';
import type { PrescriptionTemplate } from './entities/prescription-template.entity';

/**
 * DX-360: de una plantilla de receta la auditoría guarda el nombre y cuántos
 * medicamentos lleva. Los medicamentos y las notas solo por su nombre de
 * campo (`changedFields`): son contenido de la plantilla, no configuración.
 */
export const PRESCRIPTION_TEMPLATE_HIDDEN_FIELDS = ['items', 'notes'] as const;

export function prescriptionTemplateSnapshot(
  template: PrescriptionTemplate,
): ConfigSnapshot {
  return {
    name: template.name,
    notes: template.notes,
    items: JSON.stringify(template.items),
    itemCount: template.items.length,
  };
}
