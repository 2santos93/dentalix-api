import { Prisma } from '@prisma/client';
import type {
  PaymentCashChange,
  PreparedChangeLine,
} from '../../domain/cash-change';

/*
 * DX-570: lectura y alta de las líneas del vuelto de un abono, en la `tx` del
 * abono (como `payment-adjustments.persistence`).
 */

export const CHANGE_LINE_SELECT = {
  select: {
    id: true,
    line: true,
    paymentMethodId: true,
    paymentMethod: { select: { name: true } },
    method: true,
    currency: true,
    amount: true,
    reference: true,
    referenceNormalized: true,
    equivalentAmount: true,
    exchangeRateFrom: true,
    exchangeRateTo: true,
    exchangeRateSource: true,
    exchangeRateDate: true,
  },
  orderBy: { line: 'asc' },
} satisfies Prisma.Payment$changeLinesArgs;

export type ChangeLineRow = Prisma.PaymentChangeLineGetPayload<{
  select: (typeof CHANGE_LINE_SELECT)['select'];
}>;

export function changeLineOf(row: ChangeLineRow): PreparedChangeLine {
  return {
    line: row.line,
    paymentMethodId: row.paymentMethodId,
    paymentMethodName: row.paymentMethod.name,
    method: row.method,
    currency: row.currency,
    amount: row.amount.toNumber(),
    reference: row.reference,
    referenceNormalized: row.referenceNormalized,
    equivalentAmount: row.equivalentAmount.toNumber(),
    rate:
      row.exchangeRateFrom &&
      row.exchangeRateTo &&
      row.exchangeRateSource &&
      row.exchangeRateDate
        ? {
            fromPerBase: row.exchangeRateFrom.toNumber(),
            toPerBase: row.exchangeRateTo.toNumber(),
            source: row.exchangeRateSource,
            date: row.exchangeRateDate.toISOString().slice(0, 10),
          }
        : null,
  };
}

/** El vuelto de un abono leído de la BD; `null` sin «Recibido». */
export function cashChangeOf(row: {
  tenderedAmount: Prisma.Decimal | null;
  changeRemainder: Prisma.Decimal | null;
  changeLines: ChangeLineRow[];
}): PaymentCashChange | null {
  if (row.tenderedAmount === null) return null;
  return {
    tendered: row.tenderedAmount.toNumber(),
    remainderToCredit: row.changeRemainder?.toNumber() ?? 0,
    lines: row.changeLines.map(changeLineOf),
  };
}

/** Las líneas del vuelto, tras insertar el abono (misma transacción). */
export async function insertChangeLines(
  tx: Prisma.TransactionClient,
  payment: { tenantId: string; paymentId: string },
  lines: readonly PreparedChangeLine[],
): Promise<{ id: string; line: PreparedChangeLine }[]> {
  const inserted: { id: string; line: PreparedChangeLine }[] = [];
  for (const line of lines) {
    const row = await tx.paymentChangeLine.create({
      data: {
        tenantId: payment.tenantId,
        paymentId: payment.paymentId,
        line: line.line,
        paymentMethodId: line.paymentMethodId,
        method: line.method,
        currency: line.currency,
        amount: line.amount,
        reference: line.reference,
        referenceNormalized: line.referenceNormalized,
        equivalentAmount: line.equivalentAmount,
        ...(line.rate
          ? {
              exchangeRateFrom: line.rate.fromPerBase,
              exchangeRateTo: line.rate.toPerBase,
              exchangeRateSource: line.rate.source,
              exchangeRateDate: new Date(`${line.rate.date}T00:00:00.000Z`),
            }
          : {}),
      },
      select: { id: true },
    });
    inserted.push({ id: row.id, line });
  }
  return inserted;
}
