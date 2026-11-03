import { TreatmentPlanStatus } from '@prisma/client';
import { PLAN_STATUS_LABELS } from '../../treatment-plans/domain/plan-status-machine';
import { moneyWithCode } from '../../../shared/format/money-with-code';
import type { RegionalFormat } from '../../../shared/format/regional-format';
import type { AllocationViolation } from './allocation-rules';

// Mensajes de la imputación de abonos a ítems (DX-051, spec §5.3). Los
// importes salen con el formato de la sede del abono y el código ISO de la
// moneda («USD 1,234.50», «1.234,50 EUR») (DX-354b).

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
  fmt: RegionalFormat,
): string {
  return `Un ítem admite como máximo ${moneyWithCode(freeCents / 100, currency, fmt, null)}: es lo que le queda por cubrir.`;
}

export function allocationOverPayment(
  sumCents: number,
  baseCents: number,
  currency: string,
  fmt: RegionalFormat,
): string {
  return `La suma imputada (${moneyWithCode(sumCents / 100, currency, fmt, null)}) supera el abono convertido a la moneda del plan (${moneyWithCode(baseCents / 100, currency, fmt, null)}).`;
}

/**
 * Mensaje de una violación de las líneas (R10). `NO_RATE` no llega aquí: sin
 * base, el caso de uso responde 409 antes de validar líneas.
 */
export function allocationViolationMessage(
  violation: AllocationViolation,
  currency: string,
  baseCents: number,
  fmt: RegionalFormat,
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
      return allocationOverItem(violation.freeCents ?? 0, currency, fmt);
    case 'OVER_PAYMENT':
      return allocationOverPayment(
        violation.sumCents ?? 0,
        baseCents,
        currency,
        fmt,
      );
    case 'NO_RATE':
      throw new Error('NO_RATE se responde antes de validar las líneas');
  }
}
