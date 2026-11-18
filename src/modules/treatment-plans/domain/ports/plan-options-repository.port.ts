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
  /**
   * Región por defecto del teléfono de la sede de la presentación (DX-329,
   * P1): con ella se lee un número sin «+» para WhatsApp. null: no tiene.
   */
  presentedLocationPhoneRegion: string | null;
  optionGroupId: string | null;
  optionLabel: string | null;
  presentedAt: Date;
  presentedLocationId: string;
  /**
   * DX-379: zona IANA de la sede de la presentación (la de «hoy» para saber
   * si venció); `null` si no tiene una válida.
   */
  presentedLocationTimeZone: string | null;
  /** DX-379: vencimiento guardado (`YYYY-MM-DD`); `null` en planes anteriores. */
  quoteValidUntil: string | null;
  currency: string;
  /** Σ (precio − descuento) de los ítems vivos, en `currency`. */
  total: number;
  itemCount: number;
  /** DX-561: el seguimiento automático del grupo (el mismo en sus opciones). */
  followUp: PendingFollowUpState;
}

/** DX-561: el último paso registrado del seguimiento y si está en pausa. */
export interface PendingFollowUpState {
  /** 1..3, o null si aún no salió ni se omitió ningún aviso. */
  lastStep: number | null;
  /** Cuándo salió el último aviso ENVIADO (null si ninguno). */
  lastSentAt: Date | null;
  lastStatus: 'SENT' | 'SKIPPED' | null;
  /** El motivo si el último paso se omitió. */
  lastReason: string | null;
  paused: boolean;
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
   *
   * D2: pagina por GRUPO de opciones (`optionGroupId`, o el propio plan si es
   * suelto): las opciones de un grupo salen juntas y en la misma página, el
   * grupo ordenado por su presentación más antigua. `total` = grupos.
   */
  listPendingFollowUp(
    query: PendingFollowUpQuery,
  ): Promise<{ rows: PendingFollowUpRow[]; total: number }>;
}
