import { BankReconciliationMatchEndReason, Prisma } from '@prisma/client';

/**
 * DX-571: al anular un abono, su emparejado con un movimiento del extracto
 * se cierra (PAYMENT_VOIDED) en la MISMA transacción de la anulación: el
 * movimiento vuelve a «Movimiento sin abono» y la historia queda. La llama
 * `PrismaPaymentRepository.voidLine` por cada línea, como el resto de
 * reacciones a la anulación (DX-051, DX-215, DX-570). La hora la pone la BD
 * (dx_bank_match_guard). Devuelve cuántos se cerraron (0 o 1).
 */
export async function releaseBankMatchOnVoid(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; paymentId: string; voidedById: string },
): Promise<number> {
  const { count } = await tx.bankReconciliationMatch.updateMany({
    where: {
      tenantId: input.tenantId,
      paymentId: input.paymentId,
      endedAt: null,
    },
    data: {
      endedAt: new Date(),
      endedById: input.voidedById,
      endReason: BankReconciliationMatchEndReason.PAYMENT_VOIDED,
    },
  });
  return count;
}
