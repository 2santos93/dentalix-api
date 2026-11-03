import type { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';
import { PlanBalanceCalculator } from '../plan-balance-calculator';

/**
 * DX-472-bis: el calculador del saldo para pruebas cuyos abonos no piden tasa
 * en vivo (misma moneda, base o tasa congelada). Una conversión en vivo falla
 * en voz alta: la prueba que la necesite debe dar su propio convertidor.
 */
export function planBalanceWithoutLiveRates(): PlanBalanceCalculator {
  const fail = (): never => {
    throw new Error('Esta prueba no esperaba una conversión en vivo');
  };
  const convert = {
    memoized: () => ({ execute: fail, quote: fail }),
  } as unknown as ConvertAmountUseCase;
  return new PlanBalanceCalculator(convert);
}
