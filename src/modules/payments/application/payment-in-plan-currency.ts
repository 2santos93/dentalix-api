import { ExchangeRateUnavailableError } from '../../exchange/domain/ports/exchange-rate-provider.port';
import { isMissingRateError } from '../../exchange/domain/missing-exchange-rate.error';
import type { AmountConverter } from '../../exchange/application/use-cases/convert-amount.use-case';

export interface PaymentToConvert {
  amount: number;
  currency: string;
  planCurrency: string;
  /** Día civil del abono en su sede: la fecha de la tasa (DX-097). */
  paidOn: string;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

// Se tratan como «sin tasa» SOLO estos fallos: `ConvertAmountUseCase` lanza el
// primero cuando la moneda del abono no tiene tasa ese día (en el snapshot del
// proveedor o, con tasa manual, entre las que registró la clínica: DX-374), y
// el proveedor el segundo cuando no puede dar las tasas del día. Cualquier
// otro (caída de BD, tiempos de espera, error de programación) se propaga.
export function isNoRateError(error: unknown): boolean {
  if (error instanceof ExchangeRateUnavailableError) return true;
  return isMissingRateError(error);
}

/**
 * Importe de un abono en la moneda de su plan, con la tasa del día en que se
 * cobró: `round2(amount × rateUsed)`. `null` si su moneda no tiene tasa. Es la
 * conversión EN VIVO: desde DX-375 solo la usa `paymentAmountIn` para un abono
 * anterior aún sin congelar (o un destino distinto del congelado).
 */
export async function paymentInPlanCurrency(
  convert: AmountConverter,
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
    if (isNoRateError(error)) return null;
    throw error;
  }
}

/** Solo el tipo del error para los avisos: nunca datos del abono ni del paciente. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
