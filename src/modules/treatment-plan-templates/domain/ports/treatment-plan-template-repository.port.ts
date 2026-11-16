import type { CatalogKind } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { TreatmentPlanTemplate } from '../entities/treatment-plan-template.entity';
import type { PlanTemplateDraft } from '../plan-template-rules';

// Sin `tenantId`: sale del contexto del request, nunca del cliente. Las
// líneas llegan ya validadas y en su orden (posición = índice).
export interface CreatePlanTemplateRepoInput extends PlanTemplateDraft {
  active: boolean;
}

export interface UpdatePlanTemplateRepoInput {
  name?: string;
  visitIntervals?: PlanTemplateDraft['visitIntervals'];
  /** Si viene, sustituye TODAS las líneas (en este orden). */
  lines?: PlanTemplateDraft['lines'];
  active?: boolean;
  /**
   * Versión que el cliente leyó. Si la fila ya no la tiene, el repositorio
   * lanza 409 PLAN_TEMPLATE_STALE sin escribir nada (comprobación atómica).
   */
  expectedVersion: number;
}

/** Lo que la validación de una línea necesita del catálogo. */
export interface TemplateCatalogItem {
  id: string;
  kind: CatalogKind;
  labelEs: string;
}

export const TREATMENT_PLAN_TEMPLATE_REPOSITORY = Symbol(
  'TREATMENT_PLAN_TEMPLATE_REPOSITORY',
);

export interface TreatmentPlanTemplateRepository {
  /** Plantillas de la clínica en contexto, por nombre. */
  list(params: { includeInactive: boolean }): Promise<TreatmentPlanTemplate[]>;
  /** Por id, activa o no. Bajo RLS: una de otra clínica da `null`. */
  findById(id: string): Promise<TreatmentPlanTemplate | null>;
  /**
   * Procedimientos vivos (sin `deletedAt`) de la clínica con esos ids,
   * activos o no. Uno de otra clínica no aparece.
   */
  catalogItems(ids: string[]): Promise<TemplateCatalogItem[]>;
  /**
   * Crea la plantilla y escribe su evento de auditoría en la MISMA
   * transacción. 409 si el nombre ya existe (sin distinguir mayúsculas).
   */
  create(
    input: CreatePlanTemplateRepoInput,
    audit: AuditRequestContext,
  ): Promise<TreatmentPlanTemplate>;
  /**
   * Sube `version` en 1 (409 si no era la esperada), aplica el cambio y
   * escribe el evento con el antes y el después en la misma transacción.
   * `null` si la plantilla no existe en la clínica.
   */
  update(
    id: string,
    input: UpdatePlanTemplateRepoInput,
    audit: AuditRequestContext,
  ): Promise<TreatmentPlanTemplate | null>;
}
