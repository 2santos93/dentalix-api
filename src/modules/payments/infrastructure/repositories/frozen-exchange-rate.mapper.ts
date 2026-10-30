import type { ExchangeRateSource, Prisma } from '@prisma/client';
import type { FrozenExchangeRate } from '../../domain/payment-exchange-rate';
import { BASE_CURRENCY } from '../../../exchange/domain/exchange-rate-source';

/** Las columnas de la tasa congelada de `payments` (DX-375). */
export interface FrozenRateColumns {
  exchangeRateCurrency: string | null;
  exchangeRateFrom: Prisma.Decimal | null;
  exchangeRateTo: Prisma.Decimal | null;
  exchangeRateSource: ExchangeRateSource | null;
  exchangeRateDate: Date | null;
}

/** La tasa congelada de la fila, o `null` (el CHECK las exige juntas). */
export function frozenRateOf(
  row: FrozenRateColumns,
): FrozenExchangeRate | null {
  if (
    row.exchangeRateCurrency === null ||
    row.exchangeRateFrom === null ||
    row.exchangeRateTo === null ||
    row.exchangeRateSource === null ||
    row.exchangeRateDate === null
  ) {
    return null;
  }
  return {
    currency: row.exchangeRateCurrency,
    fromPerBase: Number(row.exchangeRateFrom),
    toPerBase: Number(row.exchangeRateTo),
    source: row.exchangeRateSource,
    date: row.exchangeRateDate.toISOString().slice(0, 10),
  };
}

/** `select` de Prisma con las columnas de la tasa congelada. */
export const FROZEN_RATE_SELECT = {
  exchangeRateCurrency: true,
  exchangeRateFrom: true,
  exchangeRateTo: true,
  exchangeRateSource: true,
  exchangeRateDate: true,
} as const;

/** Columnas a escribir para congelar `frozen` (DATE como medianoche UTC). */
export function frozenRateData(frozen: FrozenExchangeRate) {
  return {
    exchangeRateFrom: frozen.fromPerBase,
    exchangeRateTo: frozen.toPerBase,
    exchangeRateSource: frozen.source,
    exchangeRateDate: new Date(`${frozen.date}T00:00:00.000Z`),
  };
}

/**
 * Con fuente MANUAL, ¿siguen las tasas manuales del día como las cotizó el
 * abono? Las bloquea FOR SHARE hasta el COMMIT: una corrección en curso de la
 * tasa (que la bloquea FOR UPDATE y comprueba si algún abono la usa) espera a
 * este abono y lo ve; una que ya se confirmó da otra tasa y aquí `false`, así
 * que el abono no congela una tasa que ya no existe (queda «sin tasa» y lo
 * congela el barrido). Con fuente AUTOMATIC, `true`: la caché del proveedor no
 * se corrige.
 */
export async function manualRatesStillMatch(
  tx: Prisma.TransactionClient,
  tenantId: string,
  paymentCurrency: string,
  frozen: FrozenExchangeRate,
): Promise<boolean> {
  if (frozen.source !== 'MANUAL') return true;
  const expected = new Map<string, number>();
  if (paymentCurrency !== BASE_CURRENCY) {
    expected.set(paymentCurrency, frozen.fromPerBase);
  }
  if (frozen.currency !== BASE_CURRENCY) {
    expected.set(frozen.currency, frozen.toPerBase);
  }
  if (expected.size === 0) return true;
  const rows = await tx.$queryRaw<{ currency: string; rate: Prisma.Decimal }[]>`
    SELECT "currency", "rate" FROM "manual_exchange_rates"
     WHERE "tenantId" = ${tenantId}::uuid
       AND "date" = ${frozen.date}::date
       AND "currency" = ANY (${[...expected.keys()]}::text[])
     ORDER BY "currency"
       FOR SHARE`;
  return (
    rows.length === expected.size &&
    rows.every((row) => Number(row.rate) === expected.get(row.currency))
  );
}
