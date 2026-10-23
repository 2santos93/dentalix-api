import type { Prisma } from '@prisma/client';
import type { CurrentPolicyRef } from '../domain/cancellation-policy';

/**
 * Política VIGENTE de una sede (la versión de mayor número), dentro de la
 * transacción con tenant del llamador: la usan cancelar desde la agenda, el
 * enlace público (DX-005) y la vista previa del aviso. `null` = la sede no
 * tiene política (ninguna cancelación es tardía). La sirve el índice único
 * (tenantId, locationId, version).
 */
export async function findCurrentPolicyInTx(
  tx: Prisma.TransactionClient,
  locationId: string,
): Promise<CurrentPolicyRef | null> {
  return tx.cancellationPolicyVersion.findFirst({
    where: { locationId },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, noticeHours: true },
  });
}
