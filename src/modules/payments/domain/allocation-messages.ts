import { TreatmentPlanStatus } from '@prisma/client';
import { PLAN_STATUS_LABELS } from '../../treatment-plans/domain/plan-status-machine';
import type { AllocationViolation } from './allocation-rules';

// Mensajes de la imputación de abonos a ítems (DX-051, spec §5.3). Los
// importes salen con 2 decimales y punto, sin miles ni símbolo: formato neutro
// de locale a propósito.

/** Céntimos enteros -> «1234.50». */
export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export const ALLOCATION_PAYMENT_NOT_FOUND = 'Abono no encontrado.';
export const ALLOCATION_MIGRATED_BALANCE =
  'Este abono es de un saldo migrado: no se imputa a ítems de un plan.';
export const ALLOCATION_VERSION_CONFLICT =
  'La imputación de este abono cambió mientras la editabas. Revisa los importes y vuelve a guardar.';
export const ALLOCATION_INVALID_AMOUNT =
  'Cada importe debe ser mayor que 0 y tener como máximo 2 decimales.';
export const ALLOCATION_DUPLICATE_ITEM =
  'Cada ítem puede aparecer una sola vez.';
export const ALLOCATION_TOO_MANY_LINES = 'Como máximo 200 ítems por abono.';
export const ALLOCATION_MODE_MISMATCH =
  'Con el reparto automático no se envían importes; con el manual, sí.';
export const ALLOCATION_ITEM_NOT_IN_PLAN =
  'El ítem no es de este plan o ya no existe.';
export const ALLOCATION_ITEM_PROPOSED =
  'Solo se imputa a ítems aceptados o realizados.';
// Fuera de la tabla de §5.3: formato del cuerpo que la web nunca envía mal.
export const ALLOCATION_VERSION_INVALID =
  'La versión de la imputación no es válida: vuelve a cargar el abono.';
export const ALLOCATION_MODE_INVALID =
  'El modo de la imputación es MANUAL o AUTO.';

export function allocationPlanNotBillable(status: TreatmentPlanStatus): string {
  return `El plan está «${PLAN_STATUS_LABELS[status]}»: sus abonos no se imputan a ítems.`;
}

export function allocationNoRate(
  from: string,
  to: string,
  paidOn: string,
): string {
  return `No hay tasa de cambio de ${from} a ${to} para el ${paidOn}: este abono no se puede imputar todavía.`;
}

export function allocationOverItem(
  freeCents: number,
  currency: string,
): string {
  return `Un ítem admite como máximo ${formatCents(freeCents)} ${currency}: el resto ya lo cubren otros abonos.`;
}

export function allocationOverPayment(
  sumCents: number,
  baseCents: number,
  currency: string,
): string {
  return `La suma imputada (${formatCents(sumCents)} ${currency}) supera el abono convertido a la moneda del plan (${formatCents(baseCents)} ${currency}).`;
}

/**
 * Mensaje de una violación de las líneas (R10). `NO_RATE` no llega aquí: sin
 * base, el caso de uso responde 409 antes de validar líneas.
 */
export function allocationViolationMessage(
  violation: AllocationViolation,
  currency: string,
  baseCents: number,
): string {
  switch (violation.code) {
    case 'DUPLICATE':
      return ALLOCATION_DUPLICATE_ITEM;
    case 'TOO_MANY':
      return ALLOCATION_TOO_MANY_LINES;
    case 'NOT_IN_PLAN':
      return ALLOCATION_ITEM_NOT_IN_PLAN;
    case 'PROPOSED':
      return ALLOCATION_ITEM_PROPOSED;
    case 'OVER_ITEM':
      return allocationOverItem(violation.freeCents ?? 0, currency);
    case 'OVER_PAYMENT':
      return allocationOverPayment(
        violation.sumCents ?? 0,
        baseCents,
        currency,
      );
    case 'NO_RATE':
      throw new Error('NO_RATE se responde antes de validar las líneas');
  }
}
