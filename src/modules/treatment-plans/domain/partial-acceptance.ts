import { TreatmentPlanItemStatus, TreatmentPlanStatus } from '@prisma/client';
import type { PlanFacts } from './ports/treatment-plan-repository.port';
import {
  quoteTotal,
  type QuoteComposition,
  type QuoteSourceItem,
  type QuoteTotal,
} from './plan-quote';

/**
 * DX-417: aceptación PARCIAL del presupuesto en la clínica. El paciente firma
 * solo algunos procedimientos: el plan original queda aceptado con ellos y los
 * demás pasan (con su mismo id) a un plan nuevo, presentado y enlazado al
 * original. Aquí, las reglas puras de la partición y sus totales.
 */

/** Como mucho tantos ids elegidos por petición (como «Actualizar precios»). */
export const PARTIAL_ITEMS_MAX = 100;

export const PARTIAL_PLAN_NOT_PRESENTED_CODE = 'PARTIAL_PLAN_NOT_PRESENTED';
export const PARTIAL_PLAN_NOT_PRESENTED_MESSAGE =
  'Solo un presupuesto presentado se acepta en parte.';
export const PARTIAL_PLAN_ACCEPTED_CODE = 'PARTIAL_PLAN_ALREADY_ACCEPTED';
export const PARTIAL_PLAN_ACCEPTED_MESSAGE =
  'El plan ya está aceptado: no se puede aceptar en parte.';
export const PARTIAL_PAYMENTS_MESSAGE =
  'El plan tiene abonos registrados: no se acepta en parte. Anula los abonos o acéptalo entero.';
export const PARTIAL_PAYMENT_PLAN_MESSAGE =
  'El plan tiene un plan de cuotas activo: no se acepta en parte. Cancélalo o acéptalo entero.';
export const PARTIAL_CREDIT_MESSAGE =
  'El plan tiene saldo a favor traspasado o devuelto: no se acepta en parte.';
export const PARTIAL_ITEM_NOT_FOUND_MESSAGE =
  'Algún ítem no existe o no es de este plan de tratamiento.';
export const PARTIAL_TOO_MANY_MESSAGE = `Elige como mucho ${PARTIAL_ITEMS_MAX} procedimientos.`;
export const PARTIAL_NONE_CHOSEN_MESSAGE =
  'Elige al menos un procedimiento para aceptar.';
export const PARTIAL_ALL_CHOSEN_MESSAGE =
  'Has elegido todos los procedimientos: acéptalo entero.';
export const PARTIAL_NOT_PROPOSED_LEFT_OUT_MESSAGE =
  'Los procedimientos ya aceptados o realizados forman parte de lo aceptado.';

export type PartialAcceptanceErrorKind =
  'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT';

/** Por qué no se parte (la capa de aplicación lo traduce a HTTP). */
export class PartialAcceptanceError extends Error {
  constructor(
    readonly kind: PartialAcceptanceErrorKind,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** El plan como lo ve la partición, leído con el plan bloqueado. */
export interface PartialPlanState {
  status: TreatmentPlanStatus;
  /** ¿Ya tiene aceptación firmada? */
  signed: boolean;
  facts: PlanFacts;
  /** Ítems vivos del plan, en el orden del presupuesto, con su estado. */
  items: readonly { id: string; status: TreatmentPlanItemStatus }[];
}

/** Los ids de cada lado, en el orden del plan. */
export interface PartialSplit {
  acceptedItemIds: string[];
  pendingItemIds: string[];
}

/**
 * Parte el plan en lo aceptado (los ids elegidos) y lo pendiente (el resto).
 * Solo un plan PRESENTED, sin firma, sin abonos vivos, plan de cuotas activo
 * ni saldo a favor (los importes cobrados o financiados se calcularon con el
 * plan entero); al menos un ítem a cada lado; los ítems ya aceptados o
 * realizados van forzosamente con lo aceptado (un realizado no puede quedar
 * en un presupuesto pendiente sin cobrar). Los cargos por inasistencia viven
 * en su propio plan aceptado con ítems realizados, así que nunca se parten.
 */
export function decidePartial(
  plan: PartialPlanState,
  requested: readonly string[],
): PartialSplit {
  // Ya aceptado primero: tras una firma parcial concurrente, la segunda ve
  // el plan aceptado (409), no «algún ítem no existe» por los ya movidos.
  if (plan.signed || plan.status === TreatmentPlanStatus.ACCEPTED) {
    throw new PartialAcceptanceError(
      'CONFLICT',
      PARTIAL_PLAN_ACCEPTED_MESSAGE,
      PARTIAL_PLAN_ACCEPTED_CODE,
    );
  }
  // Después los ids: uno ajeno (de otro plan, paciente o clínica) es 404
  // sea cual sea el resto del estado del plan.
  const chosen = new Set(requested.map((id) => id.toLowerCase()));
  if (chosen.size > PARTIAL_ITEMS_MAX) {
    throw new PartialAcceptanceError('BAD_REQUEST', PARTIAL_TOO_MANY_MESSAGE);
  }
  const known = new Set(plan.items.map((i) => i.id.toLowerCase()));
  if ([...chosen].some((id) => !known.has(id))) {
    throw new PartialAcceptanceError(
      'NOT_FOUND',
      PARTIAL_ITEM_NOT_FOUND_MESSAGE,
    );
  }
  if (plan.status !== TreatmentPlanStatus.PRESENTED) {
    throw new PartialAcceptanceError(
      'CONFLICT',
      PARTIAL_PLAN_NOT_PRESENTED_MESSAGE,
      PARTIAL_PLAN_NOT_PRESENTED_CODE,
    );
  }
  if (plan.facts.hasCreditEntries) {
    throw new PartialAcceptanceError('CONFLICT', PARTIAL_CREDIT_MESSAGE);
  }
  if (plan.facts.hasLivePayments) {
    throw new PartialAcceptanceError('CONFLICT', PARTIAL_PAYMENTS_MESSAGE);
  }
  if (plan.facts.hasActivePaymentPlan) {
    throw new PartialAcceptanceError('CONFLICT', PARTIAL_PAYMENT_PLAN_MESSAGE);
  }
  if (chosen.size === 0) {
    throw new PartialAcceptanceError(
      'BAD_REQUEST',
      PARTIAL_NONE_CHOSEN_MESSAGE,
    );
  }
  const acceptedItemIds: string[] = [];
  const pendingItemIds: string[] = [];
  for (const item of plan.items) {
    if (chosen.has(item.id.toLowerCase())) {
      acceptedItemIds.push(item.id);
    } else if (item.status !== TreatmentPlanItemStatus.PROPOSED) {
      throw new PartialAcceptanceError(
        'BAD_REQUEST',
        PARTIAL_NOT_PROPOSED_LEFT_OUT_MESSAGE,
      );
    } else {
      pendingItemIds.push(item.id);
    }
  }
  if (pendingItemIds.length === 0) {
    throw new PartialAcceptanceError('BAD_REQUEST', PARTIAL_ALL_CHOSEN_MESSAGE);
  }
  return { acceptedItemIds, pendingItemIds };
}

/** Reparte filas con `id` entre los dos lados, conservando su orden. */
export function splitItems<T extends { id: string }>(
  rows: readonly T[],
  split: PartialSplit,
): { accepted: T[]; pending: T[] } {
  const accepted = new Set(split.acceptedItemIds);
  const pending = new Set(split.pendingItemIds);
  return {
    accepted: rows.filter((r) => accepted.has(r.id)),
    pending: rows.filter((r) => pending.has(r.id)),
  };
}

/**
 * Los totales de cada lado y los del plan entero. Todo se suma ítem a ítem en
 * céntimos (no hay descuento, redondeo ni ajuste a nivel de plan), así que
 * aceptado + pendiente = original por construcción, también en el ahorro por
 * convenio.
 */
export function splitTotals(
  items: readonly QuoteSourceItem[],
  split: PartialSplit,
  currency: string,
  composition: QuoteComposition = 'current',
): { accepted: QuoteTotal; pending: QuoteTotal; original: QuoteTotal } {
  const { accepted, pending } = splitItems(items, split);
  return {
    accepted: quoteTotal(accepted, currency, composition),
    pending: quoteTotal(pending, currency, composition),
    original: quoteTotal(items, currency, composition),
  };
}
