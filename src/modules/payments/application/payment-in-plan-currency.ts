import { BadRequestException } from '@nestjs/common';
import { ConvertAmountUseCase } from '../../exchange/application/use-cases/convert-amount.use-case';

export interface PaymentToConvert {
  amount: number;
  currency: string;
  planCurrency: string;
  /** Día civil del abono en su sede: la fecha de la tasa (DX-097). */
  paidOn: string;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

// `ConvertAmountUseCase` lanza esto cuando la moneda del abono no tiene tasa
// en el snapshot de esa fecha. Es el ÚNICO fallo que se trata como «sin
// tasa»; cualquier otro (caída de BD o del proveedor, error de programación)
// se propaga.
function isUnsupportedCurrencyError(error: unknown): boolean {
  return (
    error instanceof BadRequestException &&
    typeof error.message === 'string' &&
    error.message.startsWith('unsupported currency')
  );
}

/**
 * Importe de un abono en la moneda de su plan, con la tasa del día en que se
 * cobró: `round2(amount × rateUsed)`. `null` si su moneda no tiene tasa. Única
 * conversión de abonos a plan (saldo, recibo, base de imputación, backfill).
 */
export async function paymentInPlanCurrency(
  convert: ConvertAmountUseCase,
  p: PaymentToConvert,
): Promise<number | null> {
  try {
    const { rateUsed } = await convert.execute({
      amount: p.amount,
      from: p.currency,
      to: p.planCurrency,
      date: p.paidOn,
    });
    return round2(p.amount * rateUsed);
  } catch (error) {
    if (isUnsupportedCurrencyError(error)) return null;
    throw error;
  }
}

/**
 * Importe del abono para su base de imputación (spec R15): `paymentInPlanCurrency`
 * y, como la base exige `amount > 0` (CHECK), un importe que redondea a 0 cuenta
 * como «sin tasa» (`null`). Los fallos distintos de «sin tasa» se propagan.
 */
export async function paymentBaseAmount(
  convert: ConvertAmountUseCase,
  p: PaymentToConvert,
): Promise<number | null> {
  const amount = await paymentInPlanCurrency(convert, p);
  return amount !== null && amount > 0 ? amount : null;
}

/** Solo el tipo del error para los avisos: nunca datos del abono ni del paciente. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
