import { Prisma } from '@prisma/client';
import type { ComputedAdjustment } from '../../../payment-methods/domain/payment-adjustments';
import type { PaymentAdjustmentLine } from '../../domain/payment-adjustment-line';

/** DX-516: lo que se lee de cada ajuste congelado de un abono, en orden. */
export const ADJUSTMENT_LINE_SELECT = {
  select: {
    type: true,
    label: true,
    calculation: true,
    percent: true,
    fixedAmount: true,
    base: true,
    amount: true,
    currency: true,
  },
  orderBy: { position: 'asc' },
} satisfies Prisma.Payment$methodAdjustmentsArgs;

type AdjustmentRow = Prisma.PaymentAdjustmentGetPayload<
  typeof ADJUSTMENT_LINE_SELECT
>;

export function adjustmentLinesOf(
  rows: readonly AdjustmentRow[] | undefined,
): PaymentAdjustmentLine[] {
  return (rows ?? []).map((row) => ({
    type: row.type,
    label: row.label,
    calculation: row.calculation,
    percent: row.percent?.toNumber() ?? null,
    fixedAmount: row.fixedAmount?.toNumber() ?? null,
    base: row.base.toNumber(),
    amount: row.amount.toNumber(),
    currency: row.currency,
  }));
}

/**
 * DX-516: inserta los ajustes calculados de un abono recién creado, en la
 * transacción del abono (el trigger comprueba que base y moneda son las del
 * abono). Devuelve las filas como las lee `ADJUSTMENT_LINE_SELECT`.
 */
export async function insertPaymentAdjustments(
  tx: Prisma.TransactionClient,
  payment: { tenantId: string; paymentId: string },
  adjustments: readonly ComputedAdjustment[],
): Promise<AdjustmentRow[]> {
  if (adjustments.length === 0) return [];
  await tx.paymentAdjustment.createMany({
    data: adjustments.map((a) => ({
      tenantId: payment.tenantId,
      paymentId: payment.paymentId,
      position: a.position,
      sourceAdjustmentId: a.sourceAdjustmentId,
      type: a.type,
      label: a.label,
      calculation: a.calculation,
      percent: a.percent,
      fixedAmount: a.fixedAmount,
      base: a.base,
      amount: a.amount,
      currency: a.currency,
    })),
  });
  return tx.paymentAdjustment.findMany({
    where: { tenantId: payment.tenantId, paymentId: payment.paymentId },
    ...ADJUSTMENT_LINE_SELECT,
  });
}
