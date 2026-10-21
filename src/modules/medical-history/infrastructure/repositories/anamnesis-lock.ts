import type { Prisma } from '@prisma/client';

/**
 * Candado de transacción por paciente para su anamnesis (DX-247). Lo toman el
 * alta de una versión y la confirmación «Sin cambios hoy»: así una
 * confirmación nunca apunta a una versión que otra persona está reemplazando
 * en ese momento (la segunda espera al COMMIT de la primera y relee).
 */
export async function lockPatientAnamnesis(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(
    hashtext('dx_anamnesis:' || ${tenantId}),
    hashtext(${patientId})
  )`;
}
