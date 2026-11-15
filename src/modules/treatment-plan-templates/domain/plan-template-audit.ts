import type { ConfigSnapshot } from '../../audit/domain/config-audit';
import type { TreatmentPlanTemplate } from './entities/treatment-plan-template.entity';

/**
 * DX-559 (D10): de una plantilla de plan la auditoría guarda el nombre, si
 * está activa y cuántas líneas y visitas tiene. Las líneas y los intervalos
 * solo por su nombre de campo (`changedFields`): son el contenido de la
 * plantilla.
 */
export const PLAN_TEMPLATE_HIDDEN_FIELDS = ['lines', 'visitIntervals'] as const;

export function planTemplateSnapshot(
  template: Pick<
    TreatmentPlanTemplate,
    'name' | 'active' | 'visitIntervals'
  > & {
    lines: readonly {
      catalogItemId: string;
      quantity: number;
      visit: number;
      visitLabel: string | null;
      asksSurfaces: boolean;
    }[];
  },
): ConfigSnapshot {
  return {
    name: template.name,
    active: template.active,
    lineCount: template.lines.length,
    visitCount: new Set(template.lines.map((l) => l.visit)).size,
    lines: JSON.stringify(
      template.lines.map((l) => [
        l.catalogItemId,
        l.quantity,
        l.visit,
        l.visitLabel,
        l.asksSurfaces,
      ]),
    ),
    visitIntervals: JSON.stringify(
      Object.entries(template.visitIntervals).sort(
        ([a], [b]) => Number(a) - Number(b),
      ),
    ),
  };
}
