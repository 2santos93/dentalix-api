import type { PricingContext } from '../pricing/resolve-item-price';

export const PRICING_SOURCE = Symbol('PRICING_SOURCE');

/**
 * Reúne lo que `resolveItemPrice` necesita para un procedimiento y un paciente
 * (DX-105 §3): el ítem del catálogo, la asignación viva y su convenio, el
 * precio en la lista del convenio, la lista activa de la sede y el día civil de
 * hoy. La sede es la de escritura del request (`writeLocationId`, la misma que
 * sella el descuento DX-204) y «hoy» es el día en su zona (R8). Solo lee: el
 * alta del ítem lo llama ANTES de su transacción y `price-quote` sin escribir.
 */
export interface PricingSource {
  /** `null` si el procedimiento no existe en la clínica (o es de otra). */
  contextFor(
    patientId: string,
    catalogItemId: string,
    planCurrency: string,
  ): Promise<PricingContext | null>;
}
