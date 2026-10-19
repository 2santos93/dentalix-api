import type { Prisma } from '@prisma/client';

/**
 * Candado de los compromisos de pago de un paciente (DX-215), hasta el fin de
 * la transacción. Lo toman todas las escrituras de estado de sus compromisos:
 * crear uno, cerrarlo (abono o barrido) y reabrirlo al anular un abono. Quien
 * lo obtiene relee el compromiso y los abonos DESPUÉS (READ COMMITTED: foto
 * nueva por sentencia), así una anulación y un barrido simultáneos no deciden
 * con una foto vieja ni duplican transiciones o eventos.
 */
export function promiseLockKey(tenantId: string, patientId: string): string {
  return `payment_promise:${tenantId}:${patientId}`;
}

export async function lockPatientPromises(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT 1 AS locked
      FROM (SELECT pg_advisory_xact_lock(hashtextextended(${promiseLockKey(tenantId, patientId)}, 0))) l`;
}
