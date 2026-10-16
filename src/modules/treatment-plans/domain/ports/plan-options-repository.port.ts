import type {
  TreatmentPlan,
  TreatmentPlanWithItems,
} from '../entities/treatment-plan.entity';

/** El plan del que se saca una alternativa, leído con su grupo bloqueado. */
export interface AlternativeSource {
  plan: TreatmentPlanWithItems;
  /** Las OTRAS opciones vivas del grupo (vacío si el plan aún es suelto). */
  siblings: TreatmentPlan[];
}

/** Lo que el caso de uso decide para la alternativa nueva. */
export interface NewAlternative {
  /** Etiqueta del plan de origen (se fija si aún no tenía, «Opción A»). */
  sourceLabel: string;
  label: string;
  createdById?: string;
}

/** Filtro de la lista de presupuestos por seguir. */
export interface PendingFollowUpQuery {
  /** Solo los presentados en este instante o antes. */
  presentedBefore: Date;
  /** «Sin cita futura» se mide desde aquí. */
  now: Date;
  /** Base 1. */
  page: number;
  pageSize: number;
}

/** Un plan presentado y sin aceptar, con lo que recepción necesita para llamar. */
export interface PendingFollowUpRow {
  planId: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string | null;
  /** País del paciente (ISO 3166-1 alfa-2): da el indicativo para WhatsApp. */
  patientCountryCode: string | null;
  optionGroupId: string | null;
  optionLabel: string | null;
  presentedAt: Date;
  presentedLocationId: string;
  currency: string;
  /** Σ (precio − descuento) de los ítems vivos, en `currency`. */
  total: number;
  itemCount: number;
}

export const PLAN_OPTIONS_REPOSITORY = Symbol('PLAN_OPTIONS_REPOSITORY');

/** Alternativas de un plan y seguimiento de presupuestos (DX-040). */
export interface PlanOptionsRepository {
  /**
   * Crea una alternativa del plan `sourcePlanId` en UNA transacción, con el
   * grupo bloqueado: deja que `decide` valide y elija las etiquetas, mete el
   * plan de origen en un grupo si aún no tenía (el grupo es su id) y crea un
   * plan nuevo en borrador del MISMO paciente, con la misma moneda y una copia
   * de los ítems vivos (precio y descuento incluidos, en estado propuesto).
   * `null` si el plan no existe o es de otra clínica.
   */
  createAlternative(
    sourcePlanId: string,
    decide: (source: AlternativeSource) => NewAlternative,
  ): Promise<TreatmentPlan | null>;

  /**
   * Planes PRESENTED antes de `presentedBefore` cuyo paciente no tiene ninguna
   * cita futura agendada o confirmada, de los más antiguos a los más nuevos.
   * Bajo la RLS de la clínica y, si el request trae sede, solo los presentados
   * en esa sede (vista consolidada: todas).
   */
  listPendingFollowUp(
    query: PendingFollowUpQuery,
  ): Promise<{ rows: PendingFollowUpRow[]; total: number }>;
}
