import type { ExchangeRateSource, Prisma } from '@prisma/client';
import type { FrozenExchangeRate } from '../../domain/payment-exchange-rate';
import { BASE_CURRENCY } from '../../../exchange/domain/exchange-rate-source';
import { manualRateIdsOfRef } from '../../../exchange/domain/exchange-rate-quote';

/** Las columnas de la tasa congelada de `payments` (DX-375). */
export interface FrozenRateColumns {
  exchangeRateCurrency: string | null;
  exchangeRateFrom: Prisma.Decimal | null;
  exchangeRateTo: Prisma.Decimal | null;
  exchangeRateSource: ExchangeRateSource | null;
  exchangeRateDate: Date | null;
  /** DX-586 (ausentes en las lecturas que no las piden: se leen como NULL). */
  exchangeRateQuotedAt?: Date | null;
  exchangeRateValueDate?: Date | null;
  exchangeRateRef?: string | null;
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
    ref: row.exchangeRateRef ?? null,
    valueDate: row.exchangeRateValueDate
      ? row.exchangeRateValueDate.toISOString().slice(0, 10)
      : null,
    quotedAt: row.exchangeRateQuotedAt ?? null,
  };
}

/** `select` de Prisma con las columnas de la tasa congelada. */
export const FROZEN_RATE_SELECT = {
  exchangeRateCurrency: true,
  exchangeRateFrom: true,
  exchangeRateTo: true,
  exchangeRateSource: true,
  exchangeRateDate: true,
  exchangeRateQuotedAt: true,
  exchangeRateValueDate: true,
  exchangeRateRef: true,
} as const;

/**
 * Columnas a escribir para congelar `frozen` (DATE como medianoche UTC).
 * DX-586: con su referencia y su fecha valor; el instante de la cotización
 * (`exchangeRateQuotedAt`) lo pone la BD al congelar (trigger
 * payments_exchange_rate_quoted_at), nunca la API.
 */
export function frozenRateData(frozen: FrozenExchangeRate) {
  return {
    exchangeRateFrom: frozen.fromPerBase,
    exchangeRateTo: frozen.toPerBase,
    exchangeRateSource: frozen.source,
    exchangeRateDate: new Date(`${frozen.date}T00:00:00.000Z`),
    ...(frozen.ref
      ? {
          exchangeRateRef: frozen.ref,
          exchangeRateValueDate:
            frozen.source === 'BCV' && frozen.valueDate
              ? new Date(`${frozen.valueDate}T00:00:00.000Z`)
              : null,
        }
      : {}),
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
  // DX-586: con referencia, las tasas exactas que nombra (varias al día): la
  // misma moneda y la misma cifra que cotizó, por id.
  const ids = manualRateIdsOfRef(frozen.ref);
  if (ids.length > 0) {
    const byId = await tx.$queryRaw<
      { currency: string; rate: Prisma.Decimal }[]
    >`
      SELECT "currency", "rate" FROM "manual_exchange_rates"
       WHERE "tenantId" = ${tenantId}::uuid
         AND "id" = ANY (${ids}::uuid[])
       ORDER BY "id"
         FOR SHARE`;
    return (
      byId.length === expected.size &&
      byId.every((row) => Number(row.rate) === expected.get(row.currency))
    );
  }
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
