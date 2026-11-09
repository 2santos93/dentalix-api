/**
 * DX-379 (C): la sede con la que se decide (y se escribe) el vencimiento del
 * presupuesto de un plan: la de su presentación o, sin presentar, la de
 * escritura del request (D-13, como `quoteExpired`).
 */
export interface QuoteExpiryRegional {
  /** Sede de la presentación del plan cuando se leyó (null: sin presentar). */
  presentedLocationId: string | null;
  /** La sede usada: la de la presentación o la de escritura. */
  locationId: string;
  /** Zona IANA válida de esa sede, o null. */
  timeZone: string | null;
  /** Formato regional y reloj de esa sede (crudos; pueden faltar). */
  locale: string | null;
  hourCycle: string | null;
}

export interface QuoteExpiryRegionalReader {
  /** `null` si el plan no existe para esta clínica. */
  forPlan(planId: string): Promise<QuoteExpiryRegional | null>;
}

export const QUOTE_EXPIRY_REGIONAL = Symbol('QUOTE_EXPIRY_REGIONAL');
