import { ConflictException } from '@nestjs/common';
import type { TreatmentPlanWithItems } from '../../domain/entities/treatment-plan.entity';

export const SIGNED_PLAN_LOCKED_MESSAGE =
  'El plan está aceptado y firmado: sus ítems ya no se pueden cambiar.';
export const SIGNED_PLAN_HEADER_LOCKED_MESSAGE =
  'El plan está aceptado y firmado: no puede cambiar de moneda ni volver a borrador.';

/**
 * Un plan aceptado con firma (DX-012) congela lo que se firmó: sus ítems no se
 * añaden, quitan ni editan. Es la capa de aplicación (409 limpio); la capa DB
 * es el trigger `treatment_plan_items_locked_when_accepted`.
 */
export function assertItemsEditable(plan: TreatmentPlanWithItems): void {
  if (plan.acceptance) {
    throw new ConflictException(SIGNED_PLAN_LOCKED_MESSAGE);
  }
}
