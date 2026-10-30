import { BASE_CURRENCY } from '../../exchange/domain/exchange-rate-source';
import type { PaymentRatePendingDay } from './ports/payment-base-retry-repository.port';

/** Las dos monedas de un abono que espera su tasa: la suya y la de destino. */
export interface PendingRatePair {
  currency: string;
  targetCurrency: string;
}

/**
 * DX-402: a cuántos abonos pendientes de un día serviría de respaldo la tasa
 * manual de `currency`. Una cotización de respaldo necesita las DOS monedas
 * del abono ese día (`ConvertAmountUseCase.quote`): si la otra no es la base
 * (USD) ni tiene ya tasa manual registrada ese día (`manualCurrencies`), el
 * abono no se cuenta y va a `otherRatesMissing`, con la moneda que falta.
 */
export function pendingOnDayOf(
  pairs: readonly PendingRatePair[],
  currency: string,
  manualCurrencies: ReadonlySet<string>,
  providerRateSaved: boolean,
): PaymentRatePendingDay {
  let count = 0;
  let missingCount = 0;
  const missing = new Set<string>();
  for (const pair of pairs) {
    if (pair.currency === pair.targetCurrency) continue;
    if (pair.currency !== currency && pair.targetCurrency !== currency) {
      continue;
    }
    const other =
      pair.currency === currency ? pair.targetCurrency : pair.currency;
    if (other === BASE_CURRENCY || manualCurrencies.has(other)) {
      count += 1;
    } else {
      missingCount += 1;
      missing.add(other);
    }
  }
  return {
    count,
    providerRateSaved,
    otherRatesMissing: { count: missingCount, currencies: [...missing].sort() },
  };
}
