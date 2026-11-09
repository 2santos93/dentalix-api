/**
 * DX-379 (D-13): la zona de la sede con que se decide si el presupuesto de un
 * plan venció. La de su presentación o, si no se presentó (borrador impreso),
 * la sede de escritura del request (la del request o la principal).
 */
export interface PlanQuoteZones {
  /**
   * Zona IANA de cada sede pedida y de la sede de escritura (para `null`).
   * `null` si la sede no tiene una zona válida configurada.
   */
  zonesFor(
    locationIds: readonly string[],
  ): Promise<(locationId: string | null) => string | null>;
}

export const PLAN_QUOTE_ZONES = Symbol('PLAN_QUOTE_ZONES');
